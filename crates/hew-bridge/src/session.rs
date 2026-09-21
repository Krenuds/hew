//! The one piece of shared state: which browser tab currently owns this
//! bridge, and which local requests are waiting on it.
//!
//! §11.5 "Ownership" is the rule this type enforces — one tab at a time,
//! most recent wins, the displaced socket refused rather than silently
//! multiplexed. An `epoch` counter is what makes that safe against the
//! obvious race: a tab's own reader task learns it was displaced only when
//! it next looks, and must not then tear down the session its successor
//! installed, so `detach` succeeds only for the epoch that is still
//! current.
//!
//! §11.5 "Correlation" is the other: pending requests are keyed by
//! (connection, request id), not by connection alone, so a slow dispatch
//! cannot make the next request receive the previous one's answer and the
//! connection never has to be closed to prevent it.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};

use crate::protocol::ToBrowser;

/// One local connection's request, awaiting the tab's answer.
type PendingKey = (u32, String);

struct Session {
    epoch: u64,
    tx: mpsc::UnboundedSender<ToBrowser>,
}

struct State {
    session: Option<Session>,
    next_epoch: u64,
    next_conn_id: u32,
    pending: HashMap<PendingKey, oneshot::Sender<String>>,
}

pub struct Bridge {
    /// The per-launch token (§11.5): one secret, both faces — handed to an
    /// authenticated browser by `/bridge/session`, and published in the
    /// discovery file a local `--live` client reads.
    pub token: String,
    /// How long a local request waits for the tab before it is answered
    /// with a synthesized `-32003`. Spans a WAN hop, unlike §11.2's.
    pub reply_timeout: Duration,
    state: Mutex<State>,
}

impl Bridge {
    pub fn new(token: String, reply_timeout: Duration) -> Self {
        Self {
            token,
            reply_timeout,
            state: Mutex::new(State {
                session: None,
                next_epoch: 0,
                next_conn_id: 0,
                pending: HashMap::new(),
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().expect("bridge state mutex")
    }

    /// Installs `tx` as the owning session and returns its epoch plus the
    /// sender it displaced, if any — the caller owes that one a typed
    /// refusal before dropping it (§11.5).
    ///
    /// Every in-flight request is abandoned here: the tab that was going
    /// to answer them is gone, and its successor has a different document.
    /// Dropping the senders wakes each waiting local connection at once
    /// with a clean "not ready" rather than leaving it to burn the full
    /// reply timeout.
    pub fn attach(
        &self,
        tx: mpsc::UnboundedSender<ToBrowser>,
    ) -> (u64, Option<mpsc::UnboundedSender<ToBrowser>>) {
        let mut state = self.lock();
        state.next_epoch += 1;
        let epoch = state.next_epoch;
        state.pending.clear();
        let displaced = state.session.replace(Session { epoch, tx });
        (epoch, displaced.map(|s| s.tx))
    }

    /// Releases the session, but only if `epoch` is still the current one —
    /// a tab that was displaced must not tear down its successor.
    pub fn detach(&self, epoch: u64) -> bool {
        let mut state = self.lock();
        if state.session.as_ref().is_some_and(|s| s.epoch == epoch) {
            state.session = None;
            state.pending.clear();
            return true;
        }
        false
    }

    /// Whether any tab owns the session — the fact the discovery file's
    /// existence mirrors (§11.5 "Consent").
    #[cfg(test)]
    pub fn is_attached(&self) -> bool {
        self.lock().session.is_some()
    }

    /// Mints a connection id and tells the tab about it. `None` when no tab
    /// owns the session — the local side turns that into §11.5's honest
    /// "not ready" rather than a dangling connection.
    pub fn open_conn(&self) -> Option<u32> {
        let mut state = self.lock();
        let session = state.session.as_ref()?;
        let conn_id = state.next_conn_id;
        if session.tx.send(ToBrowser::Open { conn_id }).is_err() {
            return None;
        }
        state.next_conn_id = state.next_conn_id.wrapping_add(1);
        Some(conn_id)
    }

    /// Forwards one frame. `false` means the tab is gone.
    pub fn send_frame(&self, conn_id: u32, frame: String) -> bool {
        let state = self.lock();
        state
            .session
            .as_ref()
            .is_some_and(|s| s.tx.send(ToBrowser::Frame { conn_id, frame }).is_ok())
    }

    /// Tells the tab a local connection ended and forgets anything it was
    /// still waiting on.
    pub fn close_conn(&self, conn_id: u32) {
        let mut state = self.lock();
        state.pending.retain(|(id, _), _| *id != conn_id);
        if let Some(session) = state.session.as_ref() {
            let _ = session.tx.send(ToBrowser::Close { conn_id });
        }
    }

    /// Reserves the slot this request's reply will land in.
    pub fn register(&self, conn_id: u32, key: String) -> oneshot::Receiver<String> {
        let (tx, rx) = oneshot::channel();
        self.lock().pending.insert((conn_id, key), tx);
        rx
    }

    /// Hands a reply to whichever request announced the same id. A reply
    /// matching nothing — a late answer to a request already timed out, or
    /// a tab inventing one — is dropped, and the caller is told so it can
    /// log it once.
    pub fn resolve(&self, conn_id: u32, key: &str, frame: String) -> bool {
        let sender = self.lock().pending.remove(&(conn_id, key.to_string()));
        match sender {
            Some(tx) => tx.send(frame).is_ok(),
            None => false,
        }
    }

    /// Forgets one reserved slot — the timeout path, so a request that gave
    /// up does not leave its key behind for a later reply to fill.
    pub fn forget(&self, conn_id: u32, key: &str) {
        self.lock().pending.remove(&(conn_id, key.to_string()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bridge() -> Bridge {
        Bridge::new("tok".into(), Duration::from_secs(1))
    }

    #[test]
    fn no_session_means_no_connection() {
        let b = bridge();
        assert!(!b.is_attached());
        assert!(b.open_conn().is_none());
        assert!(!b.send_frame(0, "{}".into()));
    }

    #[test]
    fn the_most_recent_tab_takes_the_session() {
        let b = bridge();
        let (tx1, mut rx1) = mpsc::unbounded_channel();
        let (epoch1, displaced) = b.attach(tx1);
        assert!(displaced.is_none());

        let (tx2, _rx2) = mpsc::unbounded_channel();
        let (epoch2, displaced) = b.attach(tx2);
        assert!(
            displaced.is_some(),
            "the first tab is handed back to be refused"
        );
        assert_ne!(epoch1, epoch2);

        // The displaced tab's own detach must not take the session from
        // its successor.
        assert!(!b.detach(epoch1));
        assert!(b.is_attached());
        assert!(b.detach(epoch2));
        assert!(!b.is_attached());

        // Nothing was ever sent to the first tab beyond what the caller
        // chooses to send through the handle it got back.
        assert!(rx1.try_recv().is_err());
    }

    #[test]
    fn a_connection_reaches_the_owning_tab() {
        let b = bridge();
        let (tx, mut rx) = mpsc::unbounded_channel();
        b.attach(tx);

        let conn = b.open_conn().expect("attached");
        assert!(matches!(rx.try_recv(), Ok(ToBrowser::Open { conn_id }) if conn_id == conn));
        assert!(b.send_frame(conn, "{\"id\":1}".into()));
        assert!(matches!(rx.try_recv(), Ok(ToBrowser::Frame { .. })));
        b.close_conn(conn);
        assert!(matches!(rx.try_recv(), Ok(ToBrowser::Close { .. })));
    }

    #[tokio::test]
    async fn replies_are_correlated_by_request_id() {
        let b = bridge();
        let (tx, _rx) = mpsc::unbounded_channel();
        b.attach(tx);

        let first = b.register(0, "1".into());
        let second = b.register(0, "2".into());

        // Out of order, on purpose: each answer finds its own request.
        assert!(b.resolve(0, "2", "second".into()));
        assert!(b.resolve(0, "1", "first".into()));
        assert_eq!(first.await.unwrap(), "first");
        assert_eq!(second.await.unwrap(), "second");

        // The same id on a different connection is a different request.
        let other = b.register(1, "1".into());
        assert!(!b.resolve(2, "1", "wrong connection".into()));
        b.forget(1, "1");
        assert!(!b.resolve(1, "1", "already given up".into()));
        assert!(other.await.is_err());
    }

    #[tokio::test]
    async fn taking_the_session_abandons_every_request_in_flight() {
        let b = bridge();
        let (tx1, _rx1) = mpsc::unbounded_channel();
        b.attach(tx1);
        let waiting = b.register(0, "1".into());

        let (tx2, _rx2) = mpsc::unbounded_channel();
        b.attach(tx2);
        assert!(waiting.await.is_err(), "the answering tab is gone");
    }
}

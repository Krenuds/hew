//! §11.5's first lock: the authenticated identity at the edge.
//!
//! Cloudflare Access attaches a signed `Cf-Access-Jwt-Assertion` to every
//! request it lets through. This module verifies it here too, rather than
//! trusting that the bridge was fronted at all — defense in depth against a
//! misconfigured or bypassed Access application, the same posture (and the
//! same checks, in the same order) as `workers/bug-intake/src/adminAuth.ts`.
//!
//! It fails closed and it fails uniformly: a missing header, an
//! unverifiable token, a wrong issuer or audience, an expired assertion, an
//! unreachable JWKS endpoint and unset configuration all collapse to the
//! same bare refusal, with nothing in the response to tell them apart. The
//! failure this guards against is an attacker probing for which check to
//! attack next.
//!
//! RS256 against the team's JWKS
//! (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`), fetched
//! fresh and cached for `JWKS_CACHE` so a working session does not re-fetch
//! on every request while a key rotation still takes effect within minutes.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::http::HeaderMap;
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header};
use serde::Deserialize;

/// Matching `workers/bug-intake/src/constants.ts`'s `JWKS_CACHE_MS`.
const JWKS_CACHE: Duration = Duration::from_secs(5 * 60);
/// A JWKS fetch that hangs must not hold a request open indefinitely; the
/// caller sees the same refusal a bad signature gets.
const JWKS_FETCH_TIMEOUT: Duration = Duration::from_secs(5);

/// The header Cloudflare Access attaches. Lower-case because `HeaderMap`
/// lookups are case-insensitive but the key must be valid as written.
const ASSERTION_HEADER: &str = "cf-access-jwt-assertion";

#[derive(Clone, Deserialize)]
struct Jwk {
    kid: String,
    n: String,
    e: String,
}

#[derive(Clone, Deserialize)]
struct Jwks {
    keys: Vec<Jwk>,
}

/// Which lock the browser face is behind.
pub enum EdgeAuth {
    /// Verified Cloudflare Access assertions — the shipped posture.
    Access(Box<AccessVerifier>),
    /// Explicitly disabled by the operator (`--insecure-no-edge-auth`).
    /// The bridge warns about this on every launch; §11.5's trust model
    /// does not hold without a replacement in front of it.
    Insecure,
}

impl EdgeAuth {
    /// Whether this request carries an identity the bridge accepts.
    pub async fn permits(&self, headers: &HeaderMap) -> bool {
        match self {
            EdgeAuth::Access(verifier) => verifier.verify(headers).await,
            EdgeAuth::Insecure => true,
        }
    }

    pub fn describe(&self) -> &'static str {
        match self {
            EdgeAuth::Access(_) => "cloudflare-access",
            EdgeAuth::Insecure => "none",
        }
    }
}

pub struct AccessVerifier {
    issuer: String,
    certs_url: String,
    aud: String,
    http: reqwest::Client,
    cache: Mutex<Option<(Instant, Jwks)>>,
}

impl AccessVerifier {
    /// `team_domain` is the bare `<team>.cloudflareaccess.com`; `aud` is the
    /// Access application's audience tag. Both are required — there is no
    /// half-configured mode, only `EdgeAuth::Insecure`, which an operator
    /// has to ask for by name.
    pub fn new(team_domain: &str, aud: &str) -> Result<Self, String> {
        let team_domain = team_domain.trim().trim_end_matches('/');
        if team_domain.is_empty() || team_domain.contains("://") || team_domain.contains('/') {
            return Err(format!(
                "--access-team-domain '{team_domain}': expected a bare host like example.cloudflareaccess.com (no scheme, no path)"
            ));
        }
        if aud.trim().is_empty() {
            return Err("--access-aud must not be empty".into());
        }
        let http = reqwest::Client::builder()
            .timeout(JWKS_FETCH_TIMEOUT)
            .build()
            .map_err(|e| format!("could not build the JWKS http client: {e}"))?;
        Ok(Self {
            issuer: format!("https://{team_domain}"),
            certs_url: format!("https://{team_domain}/cdn-cgi/access/certs"),
            aud: aud.trim().to_owned(),
            http,
            cache: Mutex::new(None),
        })
    }

    async fn jwks(&self) -> Option<Jwks> {
        if let Some((fetched_at, jwks)) = self.cache.lock().expect("jwks cache mutex").as_ref()
            && fetched_at.elapsed() < JWKS_CACHE
        {
            return Some(jwks.clone());
        }
        let response = self.http.get(&self.certs_url).send().await.ok()?;
        if !response.status().is_success() {
            return None;
        }
        let jwks: Jwks = response.json().await.ok()?;
        *self.cache.lock().expect("jwks cache mutex") = Some((Instant::now(), jwks.clone()));
        Some(jwks)
    }

    async fn verify(&self, headers: &HeaderMap) -> bool {
        let Some(token) = headers.get(ASSERTION_HEADER).and_then(|v| v.to_str().ok()) else {
            return false;
        };
        let Ok(header) = decode_header(token) else {
            return false;
        };
        if header.alg != Algorithm::RS256 {
            return false;
        }
        let Some(kid) = header.kid else {
            return false;
        };
        let Some(jwks) = self.jwks().await else {
            return false;
        };
        let Some(jwk) = jwks.keys.iter().find(|k| k.kid == kid) else {
            return false;
        };
        let Ok(key) = DecodingKey::from_rsa_components(&jwk.n, &jwk.e) else {
            return false;
        };
        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_issuer(&[&self.issuer]);
        validation.set_audience(&[&self.aud]);
        decode::<serde_json::Value>(token, &key, &validation).is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_team_domain_must_be_a_bare_host() {
        assert!(AccessVerifier::new("https://team.cloudflareaccess.com", "aud").is_err());
        assert!(AccessVerifier::new("team.cloudflareaccess.com/x", "aud").is_err());
        assert!(AccessVerifier::new("", "aud").is_err());
        assert!(AccessVerifier::new("team.cloudflareaccess.com", " ").is_err());
        assert!(AccessVerifier::new("team.cloudflareaccess.com", "aud").is_ok());
    }

    #[test]
    fn the_issuer_and_certs_url_are_derived_from_the_team_domain() {
        let v = AccessVerifier::new("team.cloudflareaccess.com/", "aud").unwrap();
        assert_eq!(v.issuer, "https://team.cloudflareaccess.com");
        assert_eq!(
            v.certs_url,
            "https://team.cloudflareaccess.com/cdn-cgi/access/certs"
        );
    }

    #[tokio::test]
    async fn a_missing_or_malformed_assertion_is_refused_without_a_network_call() {
        let auth = EdgeAuth::Access(Box::new(
            AccessVerifier::new("team.cloudflareaccess.com", "aud").unwrap(),
        ));
        assert!(!auth.permits(&HeaderMap::new()).await);

        let mut headers = HeaderMap::new();
        headers.insert(ASSERTION_HEADER, "not-a-jwt".parse().unwrap());
        assert!(!auth.permits(&headers).await);
    }
}

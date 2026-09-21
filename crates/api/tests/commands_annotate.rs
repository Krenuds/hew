//! Conformance coverage for `hew.annotate.*` — dimensions and leader
//! text. A success path and a failure path per command, one-undo-entry +
//! byte-identical undo per mutating envelope, plus the two things that
//! are specific to this family: an anchor's `on` is what makes the
//! dimension follow the geometry, and `hew.annotate.radial` is a
//! declared gap that must keep refusing `unimplemented` until it is not.

use api::{Connection, DispatchOutcome, NoHost, Profile, Request, RequestId, Response, codes};
use kernel::{Document, EntityRef, Plane, Point3};
use serde_json::{Value, json};

// --------------------------------------------------------------- fixtures

fn ground() -> Plane {
    Plane::from_polygon(&[
        Point3::new(0.0, 0.0, 0.0),
        Point3::new(1.0, 0.0, 0.0),
        Point3::new(0.0, 1.0, 0.0),
    ])
    .expect("ground plane is well-defined")
}

fn build_box(doc: &mut Document, x0: f64) -> kernel::ObjectId {
    let s = doc.add_sketch(ground());
    doc.begin_sketch_gesture(s).expect("gesture");
    {
        let sk = doc.sketch_mut(s).expect("sketch is live");
        let (y0, x1, y1) = (0.0, x0 + 1.0, 1.0);
        let corners = [
            (Point3::new(x0, y0, 0.0), Point3::new(x1, y0, 0.0)),
            (Point3::new(x1, y0, 0.0), Point3::new(x1, y1, 0.0)),
            (Point3::new(x1, y1, 0.0), Point3::new(x0, y1, 0.0)),
            (Point3::new(x0, y1, 0.0), Point3::new(x0, y0, 0.0)),
        ];
        for (a, b) in corners {
            sk.add_segment(a, b).expect("rectangle segment");
        }
    }
    doc.end_sketch_gesture(s).expect("end gesture");
    let regions = doc.extrudable_regions(s).expect("live");
    doc.extrude_region(s, regions[0], 0.5)
        .expect("extrude box")
        .0
}

fn public_of(doc: &Document, entity: &EntityRef) -> String {
    let sid = doc.sid_of(entity).expect("entity carries a stable id");
    api::ids::public_id(entity, sid)
}

// ------------------------------------------------------------- dispatch harness

fn req(id: i64, method: &str, params: Value) -> Request {
    Request {
        jsonrpc: "2.0".to_string(),
        id: Some(RequestId::Number(id)),
        method: method.to_string(),
        params: Some(params),
    }
}

fn hello_attach(conn: &mut Connection, doc: &mut Document) {
    let DispatchOutcome::Reply(r) = conn.dispatch(
        doc,
        &mut NoHost,
        req(0, "hew.meta.hello", json!({ "protocol": 1 })),
    ) else {
        panic!("hello replies")
    };
    assert!(r.error.is_none(), "hello failed: {:?}", r.error);
    let DispatchOutcome::Reply(r) =
        conn.dispatch(doc, &mut NoHost, req(1, "hew.doc.attach", json!({})))
    else {
        panic!("attach replies")
    };
    assert!(r.error.is_none(), "attach failed: {:?}", r.error);
}

fn call(
    conn: &mut Connection,
    doc: &mut Document,
    id: i64,
    method: &str,
    params: Value,
) -> Response {
    let DispatchOutcome::Reply(r) = conn.dispatch(doc, &mut NoHost, req(id, method, params)) else {
        panic!("{method} replies")
    };
    r
}

fn call_ok(
    conn: &mut Connection,
    doc: &mut Document,
    id: i64,
    method: &str,
    params: Value,
) -> Value {
    let r = call(conn, doc, id, method, params);
    assert!(r.error.is_none(), "{method} refused: {:?}", r.error);
    let result = r.result.expect("a successful reply carries a result");
    result
        .get("results")
        .and_then(|r| r.as_array())
        .and_then(|r| r.first())
        .cloned()
        .unwrap_or(result)
}

fn call_err(
    conn: &mut Connection,
    doc: &mut Document,
    id: i64,
    method: &str,
    params: Value,
) -> Value {
    let r = call(conn, doc, id, method, params);
    let err = r
        .error
        .unwrap_or_else(|| panic!("{method} was expected to refuse"));
    assert_eq!(
        err.code,
        codes::REFUSED,
        "{method}'s failure should be a typed refusal"
    );
    err.data.expect("a refusal carries the canonical §4.4 data")
}

fn assert_one_undo_and_clean_undo(doc: &mut Document, depth_before: usize, bytes_before: &[u8]) {
    assert_eq!(
        doc.undo_depth(),
        depth_before + 1,
        "envelope should add exactly one undo entry"
    );
    doc.undo().expect("undo restores the compound entry");
    assert_eq!(
        doc.save(),
        bytes_before,
        "undo did not restore byte-identical state"
    );
}

/// A document with one box, attached, ready to dimension.
fn scene() -> (Document, Connection, String) {
    let mut doc = Document::new();
    let oid = build_box(&mut doc, 0.0);
    let obj = public_of(&doc, &EntityRef::Object(oid));
    let mut conn = Connection::new(Profile::Core, "test");
    hello_attach(&mut conn, &mut doc);
    (doc, conn, obj)
}

/// The only live annotation's summary, out of the scene walk.
fn only_annotation(conn: &mut Connection, doc: &mut Document, id: i64) -> Value {
    let scene = call_ok(conn, doc, id, "hew.query.scene", json!({}));
    let list = scene["annotations"]
        .as_array()
        .expect("the scene walk lists annotations")
        .clone();
    assert_eq!(list.len(), 1, "expected exactly one annotation");
    list[0].clone()
}

// ================================================================== linear

#[test]
fn linear_dimensions_a_box_edge_and_refuses_a_collinear_offset() {
    let (mut doc, mut conn, obj) = scene();
    let depth_before = doc.undo_depth();
    let bytes_before = doc.save();

    let result = call_ok(
        &mut conn,
        &mut doc,
        2,
        "hew.annotate.linear",
        json!({
            "a": { "at": [0.0, 0.0, 0.0], "on": obj },
            "b": { "at": [1.0, 0.0, 0.0], "on": obj },
            "offset": [0.0, -0.2, 0.0]
        }),
    );
    let id = result["annotation"].as_str().expect("annotation id");
    assert!(id.starts_with("ann_"), "got {id}");

    let summary = only_annotation(&mut conn, &mut doc, 3);
    assert_eq!(summary["kind"], "linear");
    assert_eq!(summary["detached"], false);
    assert_eq!(summary["measurement"], 1.0);
    assert_eq!(
        summary["anchors"][0]["on"], obj,
        "an anchor given `on` tracks that node"
    );

    assert_one_undo_and_clean_undo(&mut doc, depth_before, &bytes_before);

    // An offset along the baseline names no plane to draw in.
    let data = call_err(
        &mut conn,
        &mut doc,
        4,
        "hew.annotate.linear",
        json!({
            "a": [0.0, 0.0, 0.0],
            "b": [1.0, 0.0, 0.0],
            "offset": [0.5, 0.0, 0.0]
        }),
    );
    assert_eq!(data["refusal"], "degenerate_annotation");
}

#[test]
fn a_linear_anchor_takes_a_derived_point_and_an_explicit_plane() {
    let (mut doc, mut conn, _obj) = scene();
    let result = call_ok(
        &mut conn,
        &mut doc,
        2,
        "hew.annotate.linear",
        json!({
            "a": [0.0, 0.0, 0.0],
            "b": [0.0, 1.0, 0.0],
            "offset": [-0.2, 0.0, 0.0],
            "plane": { "origin": [0.0, 0.0, 0.0], "normal": [0.0, 0.0, 1.0] },
            "text": "TYP"
        }),
    );
    assert!(result["annotation"].as_str().is_some());

    let summary = only_annotation(&mut conn, &mut doc, 3);
    assert_eq!(summary["text_override"], "TYP");
    assert_eq!(
        summary["anchors"][0]["on"],
        Value::Null,
        "a bare point locator is free-floating"
    );
}

#[test]
fn linear_refuses_an_anchor_on_a_dead_entity() {
    let (mut doc, mut conn, _obj) = scene();
    let data = call_err(
        &mut conn,
        &mut doc,
        2,
        "hew.annotate.linear",
        json!({
            "a": { "at": [0.0, 0.0, 0.0], "on": "obj_ffffff" },
            "b": [1.0, 0.0, 0.0],
            "offset": [0.0, -0.2, 0.0]
        }),
    );
    assert_eq!(data["refusal"], "unknown_entity");
}

// ================================================================== leader

#[test]
fn leader_text_lands_and_refuses_a_zero_offset() {
    let (mut doc, mut conn, obj) = scene();
    let depth_before = doc.undo_depth();
    let bytes_before = doc.save();

    let result = call_ok(
        &mut conn,
        &mut doc,
        2,
        "hew.annotate.leader",
        json!({
            "anchor": { "at": [0.5, 0.5, 0.5], "on": obj },
            "offset": [0.3, 0.3, 0.3],
            "text": "cut to fit"
        }),
    );
    assert!(result["annotation"].as_str().is_some());

    let summary = only_annotation(&mut conn, &mut doc, 3);
    assert_eq!(summary["kind"], "leader");
    assert_eq!(summary["text"], "cut to fit");

    assert_one_undo_and_clean_undo(&mut doc, depth_before, &bytes_before);

    let r = call(
        &mut conn,
        &mut doc,
        4,
        "hew.annotate.leader",
        json!({ "anchor": [0.5, 0.5, 0.5], "offset": [0.0, 0.0, 0.0], "text": "x" }),
    );
    let err = r.error.expect("a zero offset is a static params defect");
    assert_eq!(err.code, codes::INVALID_PARAMS);
}

// ================================================================== update

#[test]
fn update_retexts_a_dimension_and_refuses_a_stale_id() {
    let (mut doc, mut conn, obj) = scene();
    let created = call_ok(
        &mut conn,
        &mut doc,
        2,
        "hew.annotate.linear",
        json!({
            "a": { "at": [0.0, 0.0, 0.0], "on": obj },
            "b": { "at": [1.0, 0.0, 0.0], "on": obj },
            "offset": [0.0, -0.2, 0.0]
        }),
    );
    let id = created["annotation"].as_str().expect("id").to_string();

    let depth_before = doc.undo_depth();
    let bytes_before = doc.save();

    let result = call_ok(
        &mut conn,
        &mut doc,
        3,
        "hew.annotate.update",
        json!({ "annotation": id, "text": "1 BAY" }),
    );
    assert_eq!(result["detached"], false);
    assert_eq!(
        only_annotation(&mut conn, &mut doc, 4)["text_override"],
        "1 BAY"
    );

    assert_one_undo_and_clean_undo(&mut doc, depth_before, &bytes_before);

    // Clearing the override falls back to the computed measurement.
    call_ok(
        &mut conn,
        &mut doc,
        5,
        "hew.annotate.update",
        json!({ "annotation": id, "text": null }),
    );
    assert_eq!(
        only_annotation(&mut conn, &mut doc, 6)["text_override"],
        Value::Null
    );

    let data = call_err(
        &mut conn,
        &mut doc,
        7,
        "hew.annotate.update",
        json!({ "annotation": "ann_ffffff", "text": "x" }),
    );
    assert_eq!(data["refusal"], "unknown_annotation");
}

#[test]
fn update_refuses_a_field_from_another_annotation_kind() {
    let (mut doc, mut conn, _obj) = scene();
    let created = call_ok(
        &mut conn,
        &mut doc,
        2,
        "hew.annotate.leader",
        json!({ "anchor": [0.5, 0.5, 0.5], "offset": [0.3, 0.3, 0.3], "text": "note" }),
    );
    let id = created["annotation"].as_str().expect("id").to_string();

    let r = call(
        &mut conn,
        &mut doc,
        3,
        "hew.annotate.update",
        json!({ "annotation": id, "plane": { "origin": [0.0, 0.0, 0.0], "normal": [0.0, 0.0, 1.0] } }),
    );
    let err = r.error.expect("a leader has no plane to set");
    assert_eq!(err.code, codes::INVALID_PARAMS);
}

// ================================================================== delete

#[test]
fn delete_removes_one_annotation_and_refuses_a_second_time() {
    let (mut doc, mut conn, obj) = scene();
    let created = call_ok(
        &mut conn,
        &mut doc,
        2,
        "hew.annotate.linear",
        json!({
            "a": { "at": [0.0, 0.0, 0.0], "on": obj },
            "b": { "at": [1.0, 0.0, 0.0], "on": obj },
            "offset": [0.0, -0.2, 0.0]
        }),
    );
    let id = created["annotation"].as_str().expect("id").to_string();

    let depth_before = doc.undo_depth();
    let bytes_before = doc.save();

    call_ok(
        &mut conn,
        &mut doc,
        3,
        "hew.annotate.delete",
        json!({ "annotation": id }),
    );
    let scene = call_ok(&mut conn, &mut doc, 4, "hew.query.scene", json!({}));
    assert_eq!(scene["annotations"].as_array().expect("array").len(), 0);

    assert_one_undo_and_clean_undo(&mut doc, depth_before, &bytes_before);

    // The undo above put it back, so delete it twice to reach the refusal.
    call_ok(
        &mut conn,
        &mut doc,
        5,
        "hew.annotate.delete",
        json!({ "annotation": id }),
    );
    let data = call_err(
        &mut conn,
        &mut doc,
        6,
        "hew.annotate.delete",
        json!({ "annotation": id }),
    );
    assert_eq!(data["refusal"], "unknown_annotation");
}

// ================================================================== queries

#[test]
fn query_entity_answers_an_annotation_id() {
    let (mut doc, mut conn, obj) = scene();
    let created = call_ok(
        &mut conn,
        &mut doc,
        2,
        "hew.annotate.linear",
        json!({
            "a": { "at": [0.0, 0.0, 0.0], "on": obj },
            "b": { "at": [1.0, 0.0, 0.0], "on": obj },
            "offset": [0.0, -0.2, 0.0]
        }),
    );
    let id = created["annotation"].as_str().expect("id").to_string();

    let entity = call_ok(
        &mut conn,
        &mut doc,
        3,
        "hew.query.entity",
        json!({ "id": id }),
    );
    assert_eq!(entity["kind"], "annotation");
    assert_eq!(entity["annotation_kind"], "linear");
    assert_eq!(entity["measurement"], 1.0);

    let data = call_err(
        &mut conn,
        &mut doc,
        4,
        "hew.query.entity",
        json!({ "id": "ann_ffffff" }),
    );
    assert_eq!(data["refusal"], "unknown_entity");
}

// ================================================================== the gap

#[test]
fn radial_is_declared_and_refuses_unimplemented() {
    let registry = api::Registry::protocol_1();
    let decl = registry
        .get("hew.annotate.radial")
        .expect("declared in the protocol-1 inventory");
    assert!(
        !decl.implemented,
        "hew.annotate.radial is still a declared gap"
    );

    let (mut doc, mut conn, _obj) = scene();
    let data = call_err(
        &mut conn,
        &mut doc,
        2,
        "hew.annotate.radial",
        json!({ "anchor": [1.0, 0.0, 0.0] }),
    );
    assert_eq!(data["refusal"], "unimplemented");
}

// ============================================================ re-anchoring

#[test]
fn a_dimension_anchored_to_an_object_follows_it_and_detaches_with_it() {
    let (mut doc, mut conn, obj) = scene();
    let created = call_ok(
        &mut conn,
        &mut doc,
        2,
        "hew.annotate.linear",
        json!({
            "a": { "at": [0.0, 0.0, 0.0], "on": obj },
            "b": { "at": [1.0, 0.0, 0.0], "on": obj },
            "offset": [0.0, -0.2, 0.0]
        }),
    );
    let id = created["annotation"].as_str().expect("id").to_string();

    call_ok(
        &mut conn,
        &mut doc,
        3,
        "hew.entity.move",
        json!({ "ids": [obj], "translation": [0.0, 0.0, 2.0] }),
    );
    let summary = only_annotation(&mut conn, &mut doc, 4);
    assert_eq!(
        summary["anchors"][0]["at"],
        json!([0.0, 0.0, 2.0]),
        "the anchor rode the move"
    );
    assert_eq!(summary["detached"], false);
    assert_eq!(summary["measurement"], 1.0);

    call_ok(
        &mut conn,
        &mut doc,
        5,
        "hew.entity.delete",
        json!({ "id": obj }),
    );
    let entity = call_ok(
        &mut conn,
        &mut doc,
        6,
        "hew.query.entity",
        json!({ "id": id }),
    );
    assert_eq!(
        entity["detached"], true,
        "deleting the anchored object detaches the dimension"
    );
}

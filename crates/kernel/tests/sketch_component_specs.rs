//! Executable specs for SKETCHES INSIDE COMPONENTS.
//!
//! Make Component takes the sketches in its selection along — a plan
//! selected beside its walls, or a plan held by a selected group — into the
//! definition, so every placement of the component shows the plan under the
//! walls. Explode gives the plan back where the walls land, and the copies a
//! definition makes of itself (make unique, the library) keep a grouped plan
//! in its group.
//!
//! Sections:
//!
//! 1. The fold: a component from a plan and its walls, exact on undo.
//! 2. Explode gives the plan back, in the right container.
//! 3. Make unique and the library copy keep a grouped plan grouped.
//! 4. Persistence of a definition-owned grouped sketch.

use kernel::{
    Document, DocumentError, GroupId, InsertOptions, InstanceId, NodeId, ObjectId, Plane, Point3,
    SketchId, Transform, Vec3,
};

// ----------------------------------------------------------------- helpers

fn ground() -> Plane {
    Plane::from_polygon(&[
        Point3::new(0.0, 0.0, 0.0),
        Point3::new(1.0, 0.0, 0.0),
        Point3::new(0.0, 1.0, 0.0),
    ])
    .expect("ground plane is well-defined")
}

fn rect_sketch(doc: &mut Document, x0: f64, y0: f64, x1: f64, y1: f64) -> SketchId {
    let s = doc.add_sketch(ground());
    let sk = doc.sketch_mut(s).expect("sketch is live and unlocked");
    for (a, b) in [
        (Point3::new(x0, y0, 0.0), Point3::new(x1, y0, 0.0)),
        (Point3::new(x1, y0, 0.0), Point3::new(x1, y1, 0.0)),
        (Point3::new(x1, y1, 0.0), Point3::new(x0, y1, 0.0)),
        (Point3::new(x0, y1, 0.0), Point3::new(x0, y0, 0.0)),
    ] {
        sk.add_segment(a, b).expect("rectangle segment");
    }
    s
}

fn a_box(doc: &mut Document, x: f64) -> ObjectId {
    let s = rect_sketch(doc, x, 0.0, x + 1.0, 1.0);
    let r = doc.extrudable_regions(s).unwrap()[0];
    doc.extrude_region(s, r, 1.0).expect("box").0
}

/// A wall and a plan at the top level.
fn wall_and_plan() -> (Document, ObjectId, SketchId) {
    let mut doc = Document::new();
    let wall = a_box(&mut doc, 0.0);
    let plan = rect_sketch(&mut doc, 5.0, 5.0, 8.0, 8.0);
    doc.set_node_name(NodeId::Sketch(plan), Some("Ground floor".into()))
        .unwrap();
    (doc, wall, plan)
}

/// A group holding a wall and a plan.
fn walls_holding_a_plan() -> (Document, GroupId, ObjectId, SketchId) {
    let (mut doc, wall, plan) = wall_and_plan();
    let (g, _) = doc
        .group_nodes(&[NodeId::Object(wall), NodeId::Sketch(plan)])
        .unwrap();
    (doc, g, wall, plan)
}

fn min_x(doc: &Document, sketch: SketchId) -> f64 {
    doc.sketch(sketch)
        .expect("sketch is live")
        .vertices()
        .values()
        .map(|v| v.position.x)
        .fold(f64::INFINITY, f64::min)
}

fn undoes_exactly(doc: &mut Document, what: &str, op: impl FnOnce(&mut Document)) {
    let before = doc.state_hash();
    op(doc);
    let after = doc.state_hash();
    assert_ne!(before, after, "{what} changed the saved document");
    doc.undo().expect("undo");
    assert_eq!(doc.state_hash(), before, "{what} undoes exactly");
    doc.redo().expect("redo");
    assert_eq!(doc.state_hash(), after, "{what} redoes exactly");
}

/// The live sketches a definition owns.
fn def_sketches(doc: &Document, comp: kernel::ComponentId) -> Vec<SketchId> {
    doc.def_member_sketches(comp)
        .unwrap()
        .into_iter()
        .filter(|&s| doc.sketch(s).is_some())
        .collect()
}

// ================================================ 1. the fold

#[test]
fn a_component_from_a_plan_and_its_wall_holds_both() {
    let (mut doc, wall, plan) = wall_and_plan();

    let mut made = None;
    undoes_exactly(&mut doc, "make_component", |d| {
        made = Some(
            d.make_component(&[NodeId::Object(wall), NodeId::Sketch(plan)])
                .expect("a component from a wall and a plan"),
        );
    });
    let (comp, inst, _) = made.unwrap();

    assert_eq!(def_sketches(&doc, comp), vec![plan]);
    assert!(
        !doc.sketch_ids().contains(&plan),
        "the plan left the world list for the definition"
    );
    assert_eq!(doc.sketch_name(plan), Some("Ground floor"));
    assert_eq!(doc.node_parent(NodeId::Sketch(plan)), None);
    assert_eq!(doc.top_level_nodes(), vec![NodeId::Instance(inst)]);

    doc.undo().unwrap();
    assert!(
        doc.sketch_ids().contains(&plan),
        "undo returns the plan to the world"
    );
    assert_eq!(doc.def_member_sketches(comp), None);
}

/// A plan held by a selected group stays in that group inside the
/// definition, and undo puts it back in the group world-side.
#[test]
fn a_grouped_plan_stays_in_its_group_inside_the_definition() {
    let (mut doc, g, _, plan) = walls_holding_a_plan();

    let mut made = None;
    undoes_exactly(&mut doc, "make_component (group)", |d| {
        made = Some(d.make_component(&[NodeId::Group(g)]).unwrap());
    });
    let (comp, _, _) = made.unwrap();

    assert_eq!(def_sketches(&doc, comp), vec![plan]);
    assert_eq!(doc.node_parent(NodeId::Sketch(plan)), Some(g));
    assert_eq!(doc.group_sketches(g), vec![plan]);

    doc.undo().unwrap();
    assert_eq!(doc.node_parent(NodeId::Sketch(plan)), Some(g));
    assert!(doc.sketch_ids().contains(&plan));
}

#[test]
fn a_component_of_a_plan_alone_is_a_component() {
    let (mut doc, _, plan) = wall_and_plan();
    let (comp, inst, _) = doc
        .make_component(&[NodeId::Sketch(plan)])
        .expect("a plan alone makes a component");
    assert_eq!(def_sketches(&doc, comp), vec![plan]);
    assert_eq!(doc.component_name(comp), Some("Ground floor"));
    assert!(doc.top_level_nodes().contains(&NodeId::Instance(inst)));
}

#[test]
fn a_second_placement_shows_the_plan_too() {
    let (mut doc, wall, plan) = wall_and_plan();
    let (comp, _, _) = doc
        .make_component(&[NodeId::Object(wall), NodeId::Sketch(plan)])
        .unwrap();
    let (second, _) = doc
        .place_instance(comp, Transform::translation(Vec3::new(20.0, 0.0, 0.0)))
        .unwrap();
    assert_eq!(doc.instance_def(second), Some(comp));
    assert_eq!(
        def_sketches(&doc, comp),
        vec![plan],
        "one definition, one plan, two placements"
    );
}

// ================================================ 2. explode

#[test]
fn exploding_gives_the_wall_and_the_plan_back() {
    let (mut doc, wall, plan) = wall_and_plan();
    let (comp, inst, _) = doc
        .make_component(&[NodeId::Object(wall), NodeId::Sketch(plan)])
        .unwrap();
    doc.transform_instance(inst, &Transform::translation(Vec3::new(10.0, 0.0, 0.0)))
        .unwrap();

    undoes_exactly(&mut doc, "explode_instance", |d| {
        d.explode_instance(inst).unwrap();
    });

    let world: Vec<SketchId> = doc.sketch_ids();
    assert_eq!(world.len(), 1, "one world plan came back");
    let back = world[0];
    assert_ne!(back, plan, "a copy, the definition keeps its own");
    assert_eq!(min_x(&doc, back), 15.0, "placed where the instance stood");
    assert_eq!(doc.sketch_name(back), Some("Ground floor"));
    assert_eq!(doc.node_parent(NodeId::Sketch(back)), None);
    assert_eq!(def_sketches(&doc, comp), vec![plan]);
}

/// An instance inside a group explodes into that group, plan included; a
/// plan held by a definition group lands in that group's copy.
#[test]
fn an_exploded_plan_lands_in_the_right_container() {
    let (mut doc, g, _, plan) = walls_holding_a_plan();
    let (_, inst, _) = doc.make_component(&[NodeId::Group(g)]).unwrap();
    let other = a_box(&mut doc, 20.0);
    let (outer, _) = doc
        .group_nodes(&[NodeId::Instance(inst), NodeId::Object(other)])
        .unwrap();

    doc.explode_instance(inst).unwrap();

    let back = *doc
        .sketch_ids()
        .iter()
        .find(|&&s| s != plan)
        .expect("the plan's copy");
    let home = doc
        .node_parent(NodeId::Sketch(back))
        .expect("inside a group");
    assert_ne!(
        home, g,
        "a copy of the definition group, not the group itself"
    );
    assert_eq!(doc.node_parent(NodeId::Group(home)), Some(outer));
    assert_eq!(doc.group_sketches(home), vec![back]);
}

// ============================================ 3. make unique, library

#[test]
fn make_unique_keeps_a_grouped_plan_in_the_copied_group() {
    let (mut doc, g, _, plan) = walls_holding_a_plan();
    let (comp, _, _) = doc.make_component(&[NodeId::Group(g)]).unwrap();
    let (second, _) = doc
        .place_instance(comp, Transform::translation(Vec3::new(20.0, 0.0, 0.0)))
        .unwrap();

    let (new_def, _) = doc.make_unique(second).unwrap();
    let [copy] = def_sketches(&doc, new_def)[..] else {
        panic!("the unique copy holds one plan");
    };
    assert_ne!(copy, plan);
    let home = doc
        .node_parent(NodeId::Sketch(copy))
        .expect("still grouped");
    assert_ne!(home, g);
    assert_eq!(doc.group_sketches(home), vec![copy]);
    assert_eq!(doc.sketch_name(copy), Some("Ground floor"));
}

#[test]
fn a_library_item_of_the_component_carries_the_grouped_plan() {
    let (mut doc, g, _, _) = walls_holding_a_plan();
    let (_, inst, _) = doc.make_component(&[NodeId::Group(g)]).unwrap();
    let item = doc
        .extract_item(&[NodeId::Instance(inst)], false)
        .expect("a component extracts with its plan");

    let mut target = Document::new();
    let (report, _) = target
        .insert_document(
            &item,
            &InsertOptions {
                pose: Transform::IDENTITY,
                provenance: None,
            },
        )
        .unwrap();
    let [NodeId::Instance(placed)] = report.roots[..] else {
        panic!("one instance root");
    };
    let comp = target.instance_def(placed).unwrap();
    let [plan] = def_sketches(&target, comp)[..] else {
        panic!("the inserted definition holds one plan");
    };
    let home = target.node_parent(NodeId::Sketch(plan)).expect("grouped");
    assert_eq!(target.group_sketches(home), vec![plan]);
}

// ======================================================== 4. persistence

#[test]
fn a_definition_owned_grouped_plan_round_trips() {
    let (mut doc, g, _, plan) = walls_holding_a_plan();
    let (_, inst, _) = doc.make_component(&[NodeId::Group(g)]).unwrap();
    let _ = (inst, plan);

    let loaded = Document::load(&doc.save()).expect("loads");
    assert_eq!(loaded.save(), doc.save(), "saves back byte-identical");
    let comp = loaded.component_ids()[0];
    let [p] = def_sketches(&loaded, comp)[..] else {
        panic!("one plan");
    };
    let home = loaded.node_parent(NodeId::Sketch(p)).expect("grouped");
    assert_eq!(loaded.group_sketches(home), vec![p]);
}

/// The ops that refused a group holding a sketch keep refusing where they
/// must: a boolean and a plain library extract of a world group.
#[test]
fn a_boolean_and_a_group_extract_still_refuse_a_held_sketch() {
    let (mut doc, g, _, _) = walls_holding_a_plan();
    let other = a_box(&mut doc, 0.5);
    assert_eq!(
        doc.boolean_nodes(
            kernel::BooleanOp::Union,
            NodeId::Group(g),
            NodeId::Object(other)
        )
        .unwrap_err(),
        DocumentError::SketchNodeUnsupported
    );
    assert_eq!(
        doc.extract_item(&[NodeId::Group(g)], false).err(),
        Some(DocumentError::SketchNodeUnsupported)
    );
    let _: Option<InstanceId> = None;
}

/// Editing the component in place surfaces its grouped plan with the group
/// and folds both back on close; the session round-trips exactly.
#[test]
fn editing_the_component_surfaces_and_refolds_the_grouped_plan() {
    let (mut doc, g, _, plan) = walls_holding_a_plan();
    let (comp, inst, _) = doc.make_component(&[NodeId::Group(g)]).unwrap();
    doc.transform_instance(inst, &Transform::translation(Vec3::new(10.0, 0.0, 0.0)))
        .unwrap();
    let closed = doc.state_hash();

    doc.open_explode_session(inst).expect("enter the component");
    assert!(
        doc.sketch_ids().contains(&plan),
        "the plan is world-side for the session"
    );
    assert_eq!(doc.node_parent(NodeId::Sketch(plan)), Some(g));
    assert_eq!(min_x(&doc, plan), 15.0, "posed where the instance stands");

    doc.close_explode_session().expect("leave the component");
    assert_eq!(doc.state_hash(), closed, "in and out changes nothing saved");
    assert_eq!(def_sketches(&doc, comp), vec![plan]);
    assert_eq!(doc.node_parent(NodeId::Sketch(plan)), Some(g));

    doc.undo().unwrap();
    doc.undo().unwrap();
    doc.redo().unwrap();
    doc.redo().unwrap();
    assert_eq!(doc.state_hash(), closed);
}

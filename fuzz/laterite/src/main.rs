// Each build runs one target, selected by feature; the fuzz macros bind action parameters they only copy and expand
// to code rustc warns about.
#![allow(dead_code, deprecated, unused_assignments, unused_mut, unused_variables)]

mod constants;
mod fixture;
mod helpers;
mod invariants;
mod session;

use crucible_fuzzer::*;

use crate::fixture::{__fixture_fuzz, Fixture};

// Every target runs the whole instruction set; each checks one area's invariants after every action.

#[invariant_test]
fn invariant_sweep(fixture: &mut Fixture) {
    invariants::sweep::check(fixture);
}

#[invariant_test]
fn invariant_attest(fixture: &mut Fixture) {
    invariants::attest::check(fixture);
}

#[invariant_test]
fn invariant_controls(fixture: &mut Fixture) {
    invariants::controls::check(fixture);
}

#[invariant_test]
fn invariant_admin(fixture: &mut Fixture) {
    invariants::admin::check(fixture);
}

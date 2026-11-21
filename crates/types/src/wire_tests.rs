//! The wire shape of the fork's own fields. The shared shapes are generated
//! for TypeScript and Swift by `pnpm gen:types`.

use serde_json::json;

use crate::{ExternalAvailability, FileMeta};

#[test]
fn file_meta_names_an_external_files_availability() {
    let meta = FileMeta {
        path: "research/big.pdf".into(),
        size: 3,
        modified_ms: 9,
        placeholder: true,
        external: Some(ExternalAvailability::of(true)),
    };
    assert_eq!(
        serde_json::to_value(&meta).unwrap(),
        json!({
            "path": "research/big.pdf",
            "size": 3,
            "modifiedMs": 9,
            "placeholder": true,
            "external": "offline"
        })
    );
}

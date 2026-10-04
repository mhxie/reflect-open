//! YAML 1.2 core-schema scalar resolution (spec §10.3.2) and the privacy
//! value rule built on it. The TS classifier
//! (`packages/core/src/markdown/frontmatter-privacy.ts`) carries the same
//! rules, and neither side uses its YAML library's own resolution for the
//! `private` value, so the two classify a scalar identically whichever parser
//! produced it.

use saphyr_parser::ScalarStyle;

/// The prefix of every core-schema tag (`!!bool` expands to `tag:yaml.org,2002:bool`).
pub(crate) const CORE_TAG_PREFIX: &str = "tag:yaml.org,2002:";

/// A scalar as the parser produced it: unescaped text, style, and full tag.
#[derive(Debug)]
pub(crate) struct Scalar {
    pub(crate) text: String,
    pub(crate) style: ScalarStyle,
    pub(crate) tag: Option<String>,
}

/// A scalar's value under the core schema.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum CoreValue<'text> {
    Null,
    Bool(bool),
    Number(f64),
    Str(&'text str),
}

/// How a `private` value reads for the privacy gate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ValueClass {
    Private,
    Public,
    /// Neither a recognized truthy nor falsy value: the note is unreadable.
    Unrecognized,
}

/// Classify a scalar `private` value. Non-core tags (`!x`, the non-specific
/// `!`) are unwrapped and the text resolved as if untagged; a core tag
/// resolves the text its own way regardless of quoting, and text the tag
/// rejects (`!!bool yes`) is private only when it is a truthy word.
pub(crate) fn classify_scalar(scalar: &Scalar) -> ValueClass {
    match scalar.tag.as_deref().and_then(core_tag_suffix) {
        Some(suffix) => match resolve_core_tagged(suffix, &scalar.text) {
            Some(value) => class_of(value),
            None if word_class(&scalar.text) == ValueClass::Private => ValueClass::Private,
            None => ValueClass::Unrecognized,
        },
        None => classify_untagged(&scalar.text, scalar.style == ScalarStyle::Plain),
    }
}

/// Classify untagged text: plain text resolves under the core schema,
/// quoted or block text is a string.
pub(crate) fn classify_untagged(text: &str, plain: bool) -> ValueClass {
    if plain {
        class_of(resolve_plain(text))
    } else {
        word_class(text)
    }
}

/// The part of a core-schema tag after its prefix (`bool` for `!!bool`).
pub(crate) fn core_tag_suffix(tag: &str) -> Option<&str> {
    tag.strip_prefix(CORE_TAG_PREFIX)
}

fn class_of(value: CoreValue<'_>) -> ValueClass {
    match value {
        CoreValue::Null | CoreValue::Bool(false) => ValueClass::Public,
        CoreValue::Bool(true) => ValueClass::Private,
        CoreValue::Number(number) => number_class(number),
        CoreValue::Str(text) => word_class(text),
    }
}

/// 1 is private and 0 (or `-0`) public; any other number, NaN included, is
/// unrecognized.
fn number_class(number: f64) -> ValueClass {
    if number == 1.0 {
        ValueClass::Private
    } else if number == 0.0 {
        ValueClass::Public
    } else {
        ValueClass::Unrecognized
    }
}

/// `coercePrivate`'s truthy words, their falsy mirrors, and the empty string.
/// Trimming and case folding are ASCII-only on both sides: Unicode trimming
/// differs between JS and Rust, and anything outside the word lists is
/// unrecognized rather than public.
fn word_class(text: &str) -> ValueClass {
    let word = text.trim_matches(|character: char| character.is_ascii_whitespace());
    let is = |words: &[&str]| {
        words
            .iter()
            .any(|candidate| word.eq_ignore_ascii_case(candidate))
    };
    if is(&["true", "yes", "on", "1"]) {
        ValueClass::Private
    } else if is(&["false", "no", "off", "0", ""]) {
        ValueClass::Public
    } else {
        ValueClass::Unrecognized
    }
}

/// Resolve an untagged plain scalar under the core schema.
pub(crate) fn resolve_plain(text: &str) -> CoreValue<'_> {
    resolve_null(text)
        .or_else(|| resolve_bool(text))
        .or_else(|| resolve_int(text))
        .or_else(|| resolve_float(text))
        .unwrap_or(CoreValue::Str(text))
}

/// Resolve `text` under an explicit core tag, or `None` when the tag rejects
/// it (or isn't one of the scalar tags the core schema defines).
pub(crate) fn resolve_core_tagged<'text>(
    suffix: &str,
    text: &'text str,
) -> Option<CoreValue<'text>> {
    match suffix {
        "str" => Some(CoreValue::Str(text)),
        "null" => resolve_null(text),
        "bool" => resolve_bool(text),
        "int" => resolve_int(text),
        "float" => resolve_float(text),
        _ => None,
    }
}

fn resolve_null(text: &str) -> Option<CoreValue<'_>> {
    matches!(text, "" | "~" | "null" | "Null" | "NULL").then_some(CoreValue::Null)
}

fn resolve_bool(text: &str) -> Option<CoreValue<'_>> {
    match text {
        "true" | "True" | "TRUE" => Some(CoreValue::Bool(true)),
        "false" | "False" | "FALSE" => Some(CoreValue::Bool(false)),
        _ => None,
    }
}

fn resolve_int(text: &str) -> Option<CoreValue<'_>> {
    if let Some(digits) = text.strip_prefix("0o") {
        return radix_value(digits, 8).map(CoreValue::Number);
    }
    if let Some(digits) = text.strip_prefix("0x") {
        return radix_value(digits, 16).map(CoreValue::Number);
    }
    let digits = text.strip_prefix(['-', '+']).unwrap_or(text);
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse::<f64>().ok().map(CoreValue::Number)
}

/// The value of an unsigned `0o`/`0x` digit run, rounded to the nearest `f64`
/// as JS does; `None` for an empty run or a digit outside the radix.
fn radix_value(digits: &str, radix: u32) -> Option<f64> {
    if digits.is_empty() || !digits.chars().all(|digit| digit.is_digit(radix)) {
        return None;
    }
    Some(match u128::from_str_radix(digits, radix) {
        Ok(value) => value as f64,
        // Past 128 bits, accumulate in floating point; such keys don't occur.
        Err(_) => digits.chars().fold(0.0, |sum, digit| {
            sum * f64::from(radix) + f64::from(digit.to_digit(radix).unwrap_or(0))
        }),
    })
}

fn resolve_float(text: &str) -> Option<CoreValue<'_>> {
    match text {
        ".inf" | ".Inf" | ".INF" | "+.inf" | "+.Inf" | "+.INF" => {
            return Some(CoreValue::Number(f64::INFINITY))
        }
        "-.inf" | "-.Inf" | "-.INF" => return Some(CoreValue::Number(f64::NEG_INFINITY)),
        ".nan" | ".NaN" | ".NAN" => return Some(CoreValue::Number(f64::NAN)),
        _ => {}
    }
    if !is_core_float(text) {
        return None;
    }
    text.parse::<f64>().ok().map(CoreValue::Number)
}

/// `[-+]? ( \. [0-9]+ | [0-9]+ ( \. [0-9]* )? ) ( [eE] [-+]? [0-9]+ )?`
fn is_core_float(text: &str) -> bool {
    let bytes = text.as_bytes();
    let digits_from = |start: usize| {
        let mut end = start;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        end
    };
    let mut index = usize::from(matches!(bytes.first(), Some(b'-' | b'+')));
    let integer_end = digits_from(index);
    if integer_end > index {
        index = integer_end;
        if bytes.get(index) == Some(&b'.') {
            index = digits_from(index + 1);
        }
    } else {
        if bytes.get(index) != Some(&b'.') {
            return false;
        }
        let fraction_end = digits_from(index + 1);
        if fraction_end == index + 1 {
            return false;
        }
        index = fraction_end;
    }
    if matches!(bytes.get(index), Some(b'e' | b'E')) {
        index += 1;
        if matches!(bytes.get(index), Some(b'-' | b'+')) {
            index += 1;
        }
        let exponent_end = digits_from(index);
        if exponent_end == index {
            return false;
        }
        index = exponent_end;
    }
    index == bytes.len()
}

/// A mapping key's identity as yaml compares keys for its duplicate-key
/// error: the resolved value, where an unresolved tag falls back to the
/// string. `None` for keys that never compare equal (NaN, other core tags).
#[derive(Debug, PartialEq, Eq, Hash)]
pub(crate) enum KeyIdentity {
    Null,
    Bool(bool),
    /// The value's bits, with `-0` folded into `0`.
    Number(u64),
    Str(String),
}

/// The identity yaml's duplicate-key check would give `scalar`.
pub(crate) fn key_identity(scalar: &Scalar) -> Option<KeyIdentity> {
    let value = match scalar.tag.as_deref() {
        Some(tag) => match core_tag_suffix(tag) {
            Some(suffix @ ("str" | "null" | "bool" | "int" | "float")) => {
                resolve_core_tagged(suffix, &scalar.text).unwrap_or(CoreValue::Str(&scalar.text))
            }
            Some(_) => return None,
            None => CoreValue::Str(&scalar.text),
        },
        None if scalar.style == ScalarStyle::Plain => resolve_plain(&scalar.text),
        None => CoreValue::Str(&scalar.text),
    };
    Some(match value {
        CoreValue::Null => KeyIdentity::Null,
        CoreValue::Bool(flag) => KeyIdentity::Bool(flag),
        CoreValue::Number(number) => {
            if number.is_nan() {
                return None;
            }
            // `-0` and `0` are the same key.
            KeyIdentity::Number(if number == 0.0 { 0 } else { number.to_bits() })
        }
        CoreValue::Str(text) => KeyIdentity::Str(text.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(text: &str) -> Scalar {
        Scalar {
            text: text.to_string(),
            style: ScalarStyle::Plain,
            tag: None,
        }
    }

    fn tagged(tag: &str, text: &str) -> Scalar {
        Scalar {
            text: text.to_string(),
            style: ScalarStyle::Plain,
            tag: Some(tag.to_string()),
        }
    }

    #[test]
    fn plain_scalars_resolve_under_the_core_schema() {
        assert_eq!(resolve_plain("~"), CoreValue::Null);
        assert_eq!(resolve_plain(""), CoreValue::Null);
        assert_eq!(resolve_plain("NULL"), CoreValue::Null);
        assert_eq!(resolve_plain("True"), CoreValue::Bool(true));
        assert_eq!(resolve_plain("FALSE"), CoreValue::Bool(false));
        assert_eq!(resolve_plain("+1"), CoreValue::Number(1.0));
        assert_eq!(resolve_plain("01"), CoreValue::Number(1.0));
        assert_eq!(resolve_plain("0x1F"), CoreValue::Number(31.0));
        assert_eq!(resolve_plain("0o17"), CoreValue::Number(15.0));
        assert_eq!(resolve_plain("1."), CoreValue::Number(1.0));
        assert_eq!(resolve_plain(".5"), CoreValue::Number(0.5));
        assert_eq!(resolve_plain("1e0"), CoreValue::Number(1.0));
        assert_eq!(resolve_plain("-.inf"), CoreValue::Number(f64::NEG_INFINITY));
        // Not the core schema: YAML 1.1 words, signed hex, underscores.
        assert_eq!(resolve_plain("yes"), CoreValue::Str("yes"));
        assert_eq!(resolve_plain("+0x1"), CoreValue::Str("+0x1"));
        assert_eq!(resolve_plain("1_000"), CoreValue::Str("1_000"));
        assert_eq!(resolve_plain("0x"), CoreValue::Str("0x"));
        assert_eq!(resolve_plain("inf"), CoreValue::Str("inf"));
    }

    #[test]
    fn values_classify_by_the_privacy_rule() {
        for text in ["true", "TRUE", "1", "1.0", "0x1", "0o1", "+1", "yes", "On"] {
            assert_eq!(classify_scalar(&plain(text)), ValueClass::Private, "{text}");
        }
        for text in ["false", "0", "0.0", "-0", "no", "OFF", "~", "null", ""] {
            assert_eq!(classify_scalar(&plain(text)), ValueClass::Public, "{text}");
        }
        for text in ["2", "-1", "y", "maybe", ".inf", ".nan", "true story"] {
            assert_eq!(
                classify_scalar(&plain(text)),
                ValueClass::Unrecognized,
                "{text}"
            );
        }
    }

    #[test]
    fn tags_unwrap_or_resolve_by_the_core_schema() {
        assert_eq!(classify_scalar(&tagged("!x", "true")), ValueClass::Private);
        assert_eq!(classify_scalar(&tagged("!x", "1.0")), ValueClass::Private);
        assert_eq!(classify_scalar(&tagged("!", "true")), ValueClass::Private);
        let core = |suffix: &str| format!("{CORE_TAG_PREFIX}{suffix}");
        assert_eq!(
            classify_scalar(&tagged(&core("bool"), "yes")),
            ValueClass::Private
        );
        assert_eq!(
            classify_scalar(&tagged(&core("bool"), "no")),
            ValueClass::Unrecognized
        );
        assert_eq!(
            classify_scalar(&tagged(&core("int"), "0x1")),
            ValueClass::Private
        );
        assert_eq!(
            classify_scalar(&tagged(&core("float"), "1")),
            ValueClass::Private
        );
        assert_eq!(
            classify_scalar(&tagged(&core("null"), "Null")),
            ValueClass::Public
        );
        assert_eq!(
            classify_scalar(&tagged(&core("str"), "1.0")),
            ValueClass::Unrecognized
        );
        let quoted_int = Scalar {
            text: "1".to_string(),
            style: ScalarStyle::DoubleQuoted,
            tag: Some(core("int")),
        };
        assert_eq!(classify_scalar(&quoted_int), ValueClass::Private);
    }

    #[test]
    fn words_trim_and_fold_ascii_only() {
        let quoted = |text: &str| Scalar {
            text: text.to_string(),
            style: ScalarStyle::SingleQuoted,
            tag: None,
        };
        assert_eq!(classify_scalar(&quoted(" TRUE \t")), ValueClass::Private);
        assert_eq!(classify_scalar(&quoted("1.0")), ValueClass::Unrecognized);
        assert_eq!(
            classify_scalar(&quoted("\u{a0}false")),
            ValueClass::Unrecognized
        );
        assert_eq!(
            classify_scalar(&quoted("\u{feff}true")),
            ValueClass::Unrecognized
        );
    }

    #[test]
    fn key_identities_follow_yaml_equality() {
        assert_eq!(key_identity(&plain("1")), key_identity(&plain("1.0")));
        assert_eq!(key_identity(&plain("1")), key_identity(&plain("0x1")));
        assert_eq!(key_identity(&plain("0")), key_identity(&plain("-0")));
        assert_eq!(key_identity(&plain("~")), key_identity(&plain("")));
        assert_eq!(key_identity(&tagged("!x", "a")), key_identity(&plain("a")));
        assert_ne!(key_identity(&plain("true")), key_identity(&plain("yes")));
        let quoted_one = Scalar {
            text: "1".to_string(),
            style: ScalarStyle::DoubleQuoted,
            tag: None,
        };
        assert_ne!(key_identity(&quoted_one), key_identity(&plain("1")));
        assert_eq!(key_identity(&plain(".nan")), None);
    }
}

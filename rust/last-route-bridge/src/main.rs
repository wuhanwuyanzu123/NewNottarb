use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::{SecondsFormat, Utc};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    process,
    thread::sleep,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const WATCHED_ADDRESS: &str = "LASTvjDWkbXM1RwUCiniHqGLSEH5xJinDRs56wNPQr9";
const WSOL_MINT: &str = "So11111111111111111111111111111111111111112";
const ADDRESS_LOOKUP_TABLE_PROGRAM: &str = "AddressLookupTab1e1111111111111111111111111";
// The bridge read RPC rejects getMultipleAccounts payloads above 50 addresses.
// Keep this read-path ceiling separate from any send-path limits.
const MAX_GET_MULTIPLE_ACCOUNTS_ADDRESSES: usize = 50;
// The supervisor treats the markets file mtime as a short liveness receipt.
// Keep that tiny file fresh without re-reading the historical JSONL or
// revalidating pools on every 250 ms bridge tick.
const ACTIVE_MARKETS_HEARTBEAT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy)]
struct PoolLayout {
    program_id: &'static str,
    label: &'static str,
    sizes: &'static [usize],
    // The NotArb instruction supplies a DEX program followed by the concrete
    // market-state account that NotArb expects in markets_file. CPMM has an
    // event-authority account between those two entries.
    market_offset: u64,
}

const POOL_LAYOUTS: &[PoolLayout] = &[
    PoolLayout {
        program_id: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
        label: "Raydium AMM v4",
        sizes: &[752],
        market_offset: 1,
    },
    PoolLayout {
        program_id: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
        label: "Pump.fun AMM",
        sizes: &[301],
        market_offset: 1,
    },
    PoolLayout {
        program_id: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
        label: "Meteora CPMM",
        sizes: &[1112],
        market_offset: 2,
    },
    PoolLayout {
        program_id: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
        label: "Meteora DLMM",
        sizes: &[904],
        market_offset: 1,
    },
    // Orca Whirlpool::LEN is 653 bytes (including Anchor discriminator).
    PoolLayout {
        program_id: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
        label: "Orca Whirlpool",
        sizes: &[653],
        market_offset: 1,
    },
];

#[derive(Debug)]
struct Options {
    root: PathBuf,
    events: PathBuf,
    route_receipt: PathBuf,
    activity: PathBuf,
    rpc_url: String,
    interval: Duration,
    max_observer_staleness: Duration,
    once: bool,
    max_markets: usize,
}

#[derive(Clone)]
struct Pool {
    address: String,
    program_id: String,
    label: String,
    data_len: usize,
    target_mints: Vec<String>,
    contains_wsol: bool,
    instruction_index: Option<u64>,
    dex_program_position: Option<u64>,
    market_position: Option<u64>,
    market_offset: Option<u64>,
}

// A market candidate is tied to the instruction-relative DEX position that
// selected it. The global message account index is deliberately not used:
// ALT placement makes it unstable across otherwise identical routes.
#[derive(Clone, Debug, PartialEq, Eq)]
struct MarketCandidate {
    address: String,
    expected_program_id: Option<String>,
    instruction_index: Option<u64>,
    dex_program_position: Option<u64>,
    market_position: Option<u64>,
    market_offset: Option<u64>,
    account_index: Option<u64>,
    source: Option<String>,
    writable: bool,
}

struct CandidateMarkets {
    source: &'static str,
    candidates: Vec<MarketCandidate>,
}

#[derive(Clone)]
struct Account {
    address: String,
    owner: Option<String>,
    data: Option<Vec<u8>>,
}

// A generic LAST-signed transaction can renew a lifecycle lease only after a
// normal route build has produced all of these matching artifacts.
struct RetainedLease {
    generation: u64,
    active_fingerprint: String,
    source: Value,
    groups: Value,
}

// A missing JSONL file is normal while the observer is starting, and a JSONL
// stream can legitimately contain transactions that are unrelated to a
// usable LAST route.  Keep those cases distinct from malformed completed
// JSONL and read/RPC failures: only the latter should be surfaced as bridge
// errors.
#[derive(Clone)]
enum LatestEvent {
    Route(Value),
    NoRouteEvidence { events_file_present: bool },
}

// The observer atomically replaces small JSON receipts.  Comparing only
// metadata keeps the 250 ms bridge loop from re-reading its historical JSONL
// (which can grow to hundreds of MB) when no new route arrived.
#[derive(Clone, Debug, PartialEq, Eq)]
enum FileStamp {
    Missing,
    Present {
        len: u64,
        modified: Option<SystemTime>,
    },
}

#[derive(Default)]
struct BridgeCache {
    route_receipt_loaded: bool,
    route_receipt_stamp: Option<FileStamp>,
    events_loaded: bool,
    events_stamp: Option<FileStamp>,
    latest_event: Option<LatestEvent>,
    activity_loaded: bool,
    activity_stamp: Option<FileStamp>,
    activity: Option<Value>,
    last_input_key: Option<String>,
    last_input_stale: Option<bool>,
    last_markets_heartbeat: Option<Instant>,
}

fn main() {
    if let Err(error) = run() {
        eprintln!(
            "{}",
            json!({"status":"last_route_bridge_fatal","error":format!("{error:#}")})
        );
        process::exit(1);
    }
}

fn run() -> Result<()> {
    let options = parse_options()?;
    let mut cache = BridgeCache::default();
    loop {
        if let Err(error) = build_with_cache(&options, &mut cache) {
            eprintln!(
                "{}",
                json!({"status":"target_markets_error","error":format!("{error:#}")})
            );
        }
        if options.once {
            break;
        }
        sleep(options.interval);
    }
    Ok(())
}

fn parse_options() -> Result<Options> {
    let mut values = Map::new();
    for argument in env::args().skip(1) {
        if let Some(raw) = argument.strip_prefix("--") {
            let (key, value) = raw.split_once('=').unwrap_or((raw, "true"));
            values.insert(key.to_owned(), Value::String(value.to_owned()));
        }
    }
    let root = values
        .get("root")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or(env::current_dir()?);
    let events = values
        .get("events")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("last-grpc-events.jsonl"));
    let route_receipt = values
        .get("route-receipt")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("last-grpc-route.json"));
    let activity = values
        .get("activity")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("last-grpc-activity.json"));
    let rpc_url = values
        .get("rpc")
        .and_then(Value::as_str)
        .unwrap_or("http://127.0.0.1:18899")
        .to_owned();
    let interval_ms = bounded_u64(
        values.get("interval").and_then(Value::as_str),
        5_000,
        250,
        300_000,
    );
    let staleness_seconds = bounded_u64(
        values
            .get("max-observer-staleness-seconds")
            .and_then(Value::as_str),
        120,
        30,
        3_600,
    );
    let max_markets =
        bounded_u64(values.get("max-markets").and_then(Value::as_str), 4, 2, 8) as usize;
    Ok(Options {
        root,
        events,
        route_receipt,
        activity,
        rpc_url,
        interval: Duration::from_millis(interval_ms),
        max_observer_staleness: Duration::from_secs(staleness_seconds),
        once: values.contains_key("once"),
        max_markets,
    })
}

fn bounded_u64(value: Option<&str>, fallback: u64, minimum: u64, maximum: u64) -> u64 {
    value
        .and_then(|item| item.parse::<u64>().ok())
        .map(|item| item.clamp(minimum, maximum))
        .unwrap_or(fallback)
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn value_path<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for key in keys {
        current = current.get(*key)?;
    }
    Some(current)
}

fn string_path(value: &Value, keys: &[&str]) -> Option<String> {
    value_path(value, keys)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn candidate_mints(event: &Value) -> Vec<String> {
    let source = value_path(event, &["arbitrageIntent", "mints"])
        .or_else(|| value_path(event, &["candidates", "mints"]));
    source
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            item.get("mint")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .collect()
}

fn candidate_dexes(event: &Value) -> Vec<Value> {
    value_path(event, &["arbitrageIntent", "dexPrograms"])
        .or_else(|| value_path(event, &["candidates", "programs"]))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn is_route_evidence(event: &Value) -> bool {
    event
        .get("watch")
        .and_then(|value| value.get("address"))
        .and_then(Value::as_str)
        == Some(WATCHED_ADDRESS)
        && event.get("success").and_then(Value::as_bool) == Some(true)
        && value_path(event, &["notArb", "matched"]).and_then(Value::as_bool) == Some(true)
        && event
            .get("accountKeys")
            .and_then(Value::as_array)
            .is_some_and(|items| !items.is_empty())
        && !candidate_mints(event).is_empty()
        && !candidate_dexes(event).is_empty()
}

fn file_stamp(path: &Path) -> Result<FileStamp> {
    match fs::metadata(path) {
        Ok(metadata) => Ok(FileStamp::Present {
            len: metadata.len(),
            modified: metadata.modified().ok(),
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(FileStamp::Missing),
        Err(error) => Err(error).with_context(|| format!("stat input: {}", path.display())),
    }
}

fn load_latest_event_from_jsonl(path: &Path) -> Result<LatestEvent> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(LatestEvent::NoRouteEvidence {
                events_file_present: false,
            });
        }
        Err(error) => {
            return Err(error).with_context(|| format!("read events: {}", path.display()))
        }
    };
    let ended = text.ends_with('\n') || text.ends_with("\r\n");
    let lines: Vec<&str> = text.lines().collect();
    for (reverse_index, line) in lines.iter().rev().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(line) {
            Ok(event) if is_route_evidence(&event) => return Ok(LatestEvent::Route(event)),
            Ok(_) => continue,
            Err(_error) if reverse_index == 0 && !ended => continue,
            Err(error) => return Err(error).context("malformed completed JSONL event"),
        }
    }
    Ok(LatestEvent::NoRouteEvidence {
        events_file_present: true,
    })
}

fn load_latest_event_cached(options: &Options, cache: &mut BridgeCache) -> Result<LatestEvent> {
    let route_receipt_stamp = file_stamp(&options.route_receipt)?;
    if route_receipt_stamp != FileStamp::Missing
        && cache.route_receipt_loaded
        && cache.route_receipt_stamp.as_ref() == Some(&route_receipt_stamp)
        && cache.latest_event.is_some()
    {
        return Ok(cache
            .latest_event
            .clone()
            .expect("latest event exists after cache check"));
    }
    cache.route_receipt_loaded = true;
    cache.route_receipt_stamp = Some(route_receipt_stamp.clone());

    if route_receipt_stamp != FileStamp::Missing {
        // A present receipt is authoritative. Never silently fall back to an
        // old JSONL row when a newly written receipt is malformed or lacks
        // route evidence; holding is safer than reviving historical pools.
        let latest = match fs::read_to_string(&options.route_receipt) {
            Ok(text) => match serde_json::from_str::<Value>(&text) {
                Ok(event) if is_route_evidence(&event) => LatestEvent::Route(event),
                // The receipt producer uses atomic replace, so this normally
                // means a bad/manual file rather than an in-flight write. Do
                // not revive historical pools from JSONL in either case.
                Ok(_) | Err(_) => LatestEvent::NoRouteEvidence {
                    events_file_present: true,
                },
            },
            // An atomic replacement can race a stat on unusual filesystems.
            // Treat that single tick as held; the next receipt is authoritative.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                LatestEvent::NoRouteEvidence {
                    events_file_present: true,
                }
            }
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("read route receipt: {}", options.route_receipt.display())
                })
            }
        };
        cache.latest_event = Some(latest.clone());
        return Ok(latest);
    }

    // Backward-compatible one-time fallback for an existing runtime that has
    // JSONL evidence but has not yet received a compact route receipt. Once
    // its metadata is unchanged, reuse the result instead of scanning it on
    // every short bridge tick.
    let events_stamp = file_stamp(&options.events)?;
    if cache.events_loaded
        && cache.events_stamp.as_ref() == Some(&events_stamp)
        && cache.latest_event.is_some()
    {
        return Ok(cache
            .latest_event
            .clone()
            .expect("latest event exists after cache check"));
    }
    let latest = load_latest_event_from_jsonl(&options.events)?;
    cache.events_loaded = true;
    cache.events_stamp = Some(events_stamp);
    cache.latest_event = Some(latest.clone());
    Ok(latest)
}

// The observer writes this lightweight receipt for each confirmed transaction
// sent by LAST itself.  It is deliberately not route evidence: route evidence
// still requires a matched NotArb instruction plus an explicit mint and DEX.
fn is_last_signer_activity(activity: &Value) -> bool {
    activity.get("success").and_then(Value::as_bool) == Some(true)
        && value_path(activity, &["watch", "address"]).and_then(Value::as_str)
            == Some(WATCHED_ADDRESS)
        && (value_path(activity, &["watch", "isSigner"]).and_then(Value::as_bool) == Some(true)
            || value_path(activity, &["watch", "feePayer"]).and_then(Value::as_str)
                == Some(WATCHED_ADDRESS))
        && activity
            .get("signature")
            .and_then(Value::as_str)
            .is_some_and(|signature| !signature.is_empty())
        && observed_at(activity).is_some()
}

fn load_last_signer_activity(path: &Path) -> Result<Option<Value>> {
    Ok(read_json_if_present(path)?.filter(is_last_signer_activity))
}

fn load_last_signer_activity_cached(
    options: &Options,
    cache: &mut BridgeCache,
) -> Result<Option<Value>> {
    let activity_stamp = file_stamp(&options.activity)?;
    if cache.activity_loaded && cache.activity_stamp.as_ref() == Some(&activity_stamp) {
        return Ok(cache.activity.clone());
    }
    let activity = load_last_signer_activity(&options.activity)?;
    cache.activity_loaded = true;
    cache.activity_stamp = Some(activity_stamp);
    cache.activity = activity.clone();
    Ok(activity)
}

fn observed_at(value: &Value) -> Option<chrono::DateTime<Utc>> {
    string_path(value, &["observedAt"])
        .and_then(|observed| chrono::DateTime::parse_from_rfc3339(&observed).ok())
        .map(|observed| observed.with_timezone(&Utc))
}

// Preserve compatibility with a fresh qualifying route when the observer has
// not yet written its compact liveness receipt. Otherwise take the newest
// LAST-signed activity, which can be a non-route instruction such as
// setLoadedAccounts.
fn latest_activity(route: &Value, signer_activity: Option<Value>) -> Value {
    match signer_activity {
        Some(activity)
            if observed_at(&activity)
                .zip(observed_at(route))
                .is_some_and(|(activity_at, route_at)| activity_at >= route_at) =>
        {
            activity
        }
        Some(activity) if observed_at(route).is_none() => activity,
        _ => route.clone(),
    }
}

fn sorted_strings(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut values: Vec<String> = values.into_iter().collect();
    values.sort();
    values
}

fn json_route_evidence_fingerprint(event: &Value) -> String {
    let mut mints = candidate_mints(event);
    mints.sort();
    let mut intended = candidate_dexes(event)
        .iter()
        .filter_map(|program| {
            program
                .get("programId")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .collect::<Vec<_>>();
    intended.sort();
    let mut invoked = value_path(event, &["execution", "invokedPrograms"])
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|program| {
            program
                .get("programId")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .collect::<Vec<_>>();
    invoked.sort();
    let mut alt_selections = event
        .get("addressLookupTables")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|table| {
            let address = table.get("address")?.as_str()?.to_owned();
            let writable = sorted_numbers(table.get("writableIndexes"));
            let readonly = sorted_numbers(table.get("readonlyIndexes"));
            Some(json!({"address":address,"writableIndexes":writable,"readonlyIndexes":readonly}))
        })
        .collect::<Vec<_>>();
    alt_selections.sort_by(|left, right| {
        left.get("address")
            .and_then(Value::as_str)
            .cmp(&right.get("address").and_then(Value::as_str))
    });
    let mut writable_route_accounts = event
        .get("accountKeys")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|key| {
            key.get("writable").and_then(Value::as_bool) == Some(true)
                && key.get("signer").and_then(Value::as_bool) != Some(true)
        })
        .filter_map(|key| {
            key.get("pubkey")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .collect::<Vec<_>>();
    writable_route_accounts.sort();
    serde_json::to_string(&json!({
        "mints":mints,
        "intendedDexes":intended,
        "invokedDexes":invoked,
        "executionKind":value_path(event, &["execution", "kind"]).cloned().unwrap_or(Value::Null),
        "altSelections":alt_selections,
        "writableRouteAccounts":writable_route_accounts,
    }))
    .expect("JSON serializes")
}

fn sorted_numbers(value: Option<&Value>) -> Vec<u64> {
    let mut values = value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_u64)
        .collect::<Vec<_>>();
    values.sort();
    values
}

fn source_for(event: &Value) -> Value {
    json!({
        "watchedAddress":WATCHED_ADDRESS,
        "signature":event.get("signature").cloned().unwrap_or(Value::Null),
        "slot":event.get("slot").cloned().unwrap_or(Value::Null),
        "observedAt":event.get("observedAt").cloned().unwrap_or(Value::Null),
    })
}

fn observer_for(activity: &Value, route: &Value, fingerprint: &str, stale: bool) -> Value {
    json!({
        "lastObservedAt":activity.get("observedAt").cloned().unwrap_or(Value::Null),
        "lastSignature":activity.get("signature").cloned().unwrap_or(Value::Null),
        "lastSlot":activity.get("slot").cloned().unwrap_or(Value::Null),
        "lastRouteObservedAt":route.get("observedAt").cloned().unwrap_or(Value::Null),
        "lastRouteSignature":route.get("signature").cloned().unwrap_or(Value::Null),
        "lastRouteSlot":route.get("slot").cloned().unwrap_or(Value::Null),
        "routeEvidenceFingerprint":fingerprint,
        "stale":stale,
    })
}

fn state_for(activity: &Value, route: &Value, fingerprint: &str, stale: bool) -> Value {
    json!({
        "schemaVersion":4,
        "seen":[],
        "lastSlot":activity.get("slot").cloned().unwrap_or(Value::Null),
        "lastSignature":activity.get("signature").cloned().unwrap_or(Value::Null),
        "lastObservedAt":activity.get("observedAt").cloned().unwrap_or(Value::Null),
        "lastRouteSlot":route.get("slot").cloned().unwrap_or(Value::Null),
        "lastRouteSignature":route.get("signature").cloned().unwrap_or(Value::Null),
        "lastRouteObservedAt":route.get("observedAt").cloned().unwrap_or(Value::Null),
        "lastRouteFingerprint":fingerprint,
        "activeRoute":fingerprint,
        "stale":stale,
        "knownAltTables":[],
        "window":{"startedAt":now_iso(),"total":0,"noFill":0,"fills":0,"failed":0,"other":0},
        "lastSummaryAt":0,
        "savedAt":now_iso(),
    })
}

fn event_is_stale(event: &Value, maximum: Duration) -> bool {
    let Some(observed) = observed_at(event) else {
        return true;
    };
    let age = Utc::now().signed_duration_since(observed);
    age.to_std().map_or(true, |age| age > maximum)
}

fn find_layout(program_id: &str) -> Option<PoolLayout> {
    POOL_LAYOUTS
        .iter()
        .copied()
        .find(|layout| layout.program_id == program_id)
}

fn unsupported_dexes(event: &Value) -> Vec<Value> {
    candidate_dexes(event)
        .into_iter()
        .filter(|program| {
            program
                .get("programId")
                .and_then(Value::as_str)
                .and_then(find_layout)
                .is_none()
        })
        .collect()
}

fn rpc_account_batches(addresses: &[String]) -> impl Iterator<Item = &[String]> {
    addresses.chunks(MAX_GET_MULTIPLE_ACCOUNTS_ADDRESSES)
}

fn decode_rpc_accounts(addresses: &[String], values: &[Value]) -> Vec<Account> {
    // zip intentionally preserves the historical handling of malformed
    // result lengths: only positions returned by the RPC are materialized.
    addresses
        .iter()
        .zip(values)
        .map(|(address, account)| {
            let owner = account
                .get("owner")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            let data = value_path(account, &["data"])
                .and_then(Value::as_array)
                .and_then(|data| data.first())
                .and_then(Value::as_str)
                .and_then(|encoded| BASE64.decode(encoded).ok());
            Account {
                address: address.clone(),
                owner,
                data,
            }
        })
        .collect()
}

fn rpc_accounts(rpc_url: &str, addresses: &[String]) -> Result<Vec<Account>> {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(20))
        .build();
    let mut accounts = Vec::with_capacity(addresses.len());
    for chunk in rpc_account_batches(addresses) {
        let request = json!({
            "jsonrpc":"2.0",
            "id": now_ms(),
            "method":"getMultipleAccounts",
            "params":[chunk,{"encoding":"base64"}],
        });
        let response: Value = agent
            .post(rpc_url)
            .send_json(request)
            .with_context(|| "getMultipleAccounts request")?
            .into_json()
            .with_context(|| "decode getMultipleAccounts response")?;
        if let Some(error) = response.get("error") {
            return Err(anyhow!("getMultipleAccounts: {error}"));
        }
        let values = value_path(&response, &["result", "value"])
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("getMultipleAccounts missing result.value"))?;
        // Chunks are requested serially and extended in request order, so the
        // merged result remains aligned with the caller's address order.
        accounts.extend(decode_rpc_accounts(chunk, values));
    }
    Ok(accounts)
}

fn instruction_position(account: &Value) -> Option<u64> {
    account.get("position").and_then(Value::as_u64)
}

fn has_na_instruction_vector(event: &Value) -> bool {
    event
        .get("notArb")
        .and_then(|value| value.get("instructions"))
        .and_then(Value::as_array)
        .is_some()
}

// The markets_file is not a list of every account used by a DEX CPI. It must
// contain the concrete market-state account for each DEX leg. Preserve the
// outer NA instruction's relative positions and derive exactly those accounts
// from the DEX program's verified offset. A fresh expanded NA vector must not
// silently fall back to the broad transaction account list.
fn na_instruction_market_candidates(event: &Value) -> Vec<MarketCandidate> {
    let mut candidates = Vec::new();
    for instruction in event
        .get("notArb")
        .and_then(|value| value.get("instructions"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let instruction_index = instruction.get("index").and_then(Value::as_u64);
        let Some(accounts) = instruction.get("accounts").and_then(Value::as_array) else {
            continue;
        };
        for program_account in accounts {
            let Some(program_id) = program_account.get("pubkey").and_then(Value::as_str) else {
                continue;
            };
            let Some(layout) = find_layout(program_id) else {
                continue;
            };
            let Some(dex_program_position) = instruction_position(program_account) else {
                continue;
            };
            let Some(market_position) = dex_program_position.checked_add(layout.market_offset)
            else {
                continue;
            };
            let Some(market_account) = accounts
                .iter()
                .find(|account| instruction_position(account) == Some(market_position))
            else {
                continue;
            };
            let Some(address) = market_account.get("pubkey").and_then(Value::as_str) else {
                continue;
            };
            // All observed NotArb market-state accounts are writable. Requiring
            // that flag rejects an event authority, program, or read-only meta
            // that happens to occupy a nearby position.
            if market_account.get("writable").and_then(Value::as_bool) != Some(true) {
                continue;
            }
            candidates.push(MarketCandidate {
                address: address.to_owned(),
                expected_program_id: Some(program_id.to_owned()),
                instruction_index,
                dex_program_position: Some(dex_program_position),
                market_position: Some(market_position),
                market_offset: Some(layout.market_offset),
                account_index: market_account.get("accountIndex").and_then(Value::as_u64),
                source: market_account
                    .get("source")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                writable: true,
            });
        }
    }
    candidates.sort_by(|left, right| {
        left.instruction_index
            .cmp(&right.instruction_index)
            .then(left.market_position.cmp(&right.market_position))
            .then(left.address.cmp(&right.address))
    });
    candidates.dedup_by(|left, right| {
        left.instruction_index == right.instruction_index
            && left.market_position == right.market_position
            && left.address == right.address
    });
    candidates
}

fn market_candidates(event: &Value) -> CandidateMarkets {
    if has_na_instruction_vector(event) {
        return CandidateMarkets {
            source: "na_instruction_market_pairs",
            candidates: na_instruction_market_candidates(event),
        };
    }

    // Old persisted receipts predate notArb.instructions[]. Keep the broad
    // account-key fallback solely so historical evidence remains readable;
    // it is never used when a fresh NA account vector is available.
    let mut values = BTreeSet::new();
    for key in event
        .get("accountKeys")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(address) = key.get("pubkey").and_then(Value::as_str) {
            values.insert(address.to_owned());
        }
    }
    CandidateMarkets {
        source: "legacy_transaction_accounts",
        candidates: values
            .into_iter()
            .map(|address| MarketCandidate {
                address,
                expected_program_id: None,
                instruction_index: None,
                dex_program_position: None,
                market_position: None,
                market_offset: None,
                account_index: None,
                source: None,
                writable: false,
            })
            .collect(),
    }
}

fn na_instruction_market_references(event: &Value, address: &str) -> Vec<Value> {
    na_instruction_market_candidates(event)
        .into_iter()
        .filter(|candidate| candidate.address == address)
        .map(|candidate| {
            json!({
                "topLevelInstructionIndex":candidate.instruction_index,
                "dexProgramId":candidate.expected_program_id,
                "dexProgramPosition":candidate.dex_program_position,
                "marketPosition":candidate.market_position,
                "marketOffset":candidate.market_offset,
                "accountIndex":candidate.account_index,
                "source":candidate.source,
                "writable":candidate.writable,
            })
        })
        .collect()
}

fn route_pools(
    event: &Value,
    candidates: &[MarketCandidate],
    accounts: &[Account],
) -> Result<Vec<Pool>> {
    let targets = candidate_mints(event)
        .into_iter()
        .map(|mint| {
            let bytes = bs58::decode(&mint)
                .into_vec()
                .with_context(|| format!("base58 target mint {mint}"))?;
            Ok((mint, bytes))
        })
        .collect::<Result<Vec<_>>>()?;
    let wsol = bs58::decode(WSOL_MINT).into_vec().context("base58 WSOL")?;
    let mut pools = Vec::new();
    for (candidate, account) in candidates.iter().zip(accounts) {
        let Some(owner) = account.owner.as_deref() else {
            continue;
        };
        if candidate
            .expected_program_id
            .as_deref()
            .is_some_and(|expected| expected != owner)
        {
            continue;
        }
        let Some(layout) = find_layout(owner) else {
            continue;
        };
        let Some(data) = account.data.as_deref() else {
            continue;
        };
        if !layout.sizes.contains(&data.len()) {
            continue;
        }
        let target_mints = targets
            .iter()
            .filter(|(_, mint_bytes)| contains(data, mint_bytes))
            .map(|(mint, _)| mint.clone())
            .collect::<Vec<_>>();
        // A fresh NA instruction defines the complete NotArb route group.
        // Include a verified market-state even when it is an intermediate
        // WSOL-USDC or target-USDC leg and therefore does not contain the
        // route's headline target mint. The historical fallback retains the
        // former target-mint gate because it has no instruction-local proof.
        if target_mints.is_empty() && candidate.instruction_index.is_none() {
            continue;
        }
        pools.push(Pool {
            address: account.address.clone(),
            program_id: owner.to_owned(),
            label: layout.label.to_owned(),
            data_len: data.len(),
            target_mints,
            contains_wsol: contains(data, &wsol),
            instruction_index: candidate.instruction_index,
            dex_program_position: candidate.dex_program_position,
            market_position: candidate.market_position,
            market_offset: candidate.market_offset,
        });
    }
    Ok(pools)
}

fn contains(data: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && data.windows(needle.len()).any(|window| window == needle)
}

fn na_instruction_market_groups(pools: &[Pool]) -> Vec<Vec<String>> {
    let mut by_instruction = BTreeMap::<u64, Vec<&Pool>>::new();
    for pool in pools {
        let Some(instruction_index) = pool.instruction_index else {
            continue;
        };
        by_instruction
            .entry(instruction_index)
            .or_default()
            .push(pool);
    }
    by_instruction
        .into_values()
        .filter_map(|mut markets| {
            // Preserve the exact route order from the NA instruction rather
            // than alphabetizing addresses or re-filtering on WSOL. NotArb
            // expects a complete group of concrete market-state accounts.
            markets.sort_by(|left, right| {
                left.market_position
                    .cmp(&right.market_position)
                    .then(left.address.cmp(&right.address))
            });
            let mut seen = BTreeSet::new();
            let addresses = markets
                .into_iter()
                .filter_map(|market| {
                    seen.insert(market.address.clone())
                        .then(|| market.address.clone())
                })
                .collect::<Vec<_>>();
            (addresses.len() >= 2).then_some(addresses)
        })
        .collect()
}

fn market_groups(
    source: &str,
    targets: &[String],
    pools: &[Pool],
    max_markets: usize,
) -> Vec<Vec<String>> {
    if source == "na_instruction_market_pairs" {
        return na_instruction_market_groups(pools);
    }
    // Compatibility only for historical receipts that lack the expanded NA
    // instruction vector. Fresh route output always takes the exact branch
    // above and never applies the target-mint/WSOL heuristic.
    let mut groups = Vec::new();
    for target in targets {
        let mut candidates = pools
            .iter()
            .filter(|pool| pool.target_mints.iter().any(|mint| mint == target))
            .collect::<Vec<_>>();
        let mut direct = candidates
            .iter()
            .copied()
            .filter(|pool| pool.contains_wsol)
            .collect::<Vec<_>>();
        let selected = if direct.len() >= 2 {
            &mut direct
        } else {
            &mut candidates
        };
        selected.sort_by(|left, right| left.address.cmp(&right.address));
        let mut addresses = selected
            .iter()
            .take(max_markets)
            .map(|pool| pool.address.clone())
            .collect::<Vec<_>>();
        addresses.sort();
        if addresses.len() >= 2 {
            groups.push(addresses);
        }
    }
    groups.sort();
    groups
}

fn observed_alts(event: &Value) -> Vec<String> {
    let mut values = BTreeSet::new();
    for table in event
        .get("addressLookupTables")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(address) = table.get("address").and_then(Value::as_str) {
            values.insert(address.to_owned());
        }
    }
    values.into_iter().collect()
}

fn validate_alts(accounts: &[Account]) -> (Vec<String>, Vec<Value>) {
    let mut valid = Vec::new();
    let mut rejected = Vec::new();
    for account in accounts {
        let reason = match (&account.owner, &account.data) {
            (None, _) => Some("account_not_found".to_owned()),
            (Some(owner), _) if owner != ADDRESS_LOOKUP_TABLE_PROGRAM => {
                Some(format!("unexpected_owner:{owner}"))
            }
            (_, None) => Some("missing_binary_account_data".to_owned()),
            _ => None,
        };
        if let Some(reason) = reason {
            rejected.push(json!({"address":account.address,"reason":reason}));
        } else {
            valid.push(account.address.clone());
        }
    }
    (valid, rejected)
}

fn sha256(value: &Value) -> String {
    let bytes = serde_json::to_vec(value).expect("JSON serializes");
    format!("{:x}", Sha256::digest(bytes))
}

fn read_json_if_present(path: &Path) -> Result<Option<Value>> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(
            serde_json::from_str(&text).with_context(|| format!("parse {}", path.display()))?,
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error).with_context(|| format!("read {}", path.display())),
    }
}

fn write_json_atomically(path: &Path, value: &Value) -> Result<()> {
    let text = format!("{}\n", serde_json::to_string_pretty(value)?);
    write_text_atomically(path, &text)
}

// NotArb's documented JSON markets_file object. Keep the route group as a
// two-dimensional array and refresh its timestamp whenever the active lease is
// renewed so NotArb can reject stale input safely.
fn notarb_markets_file(groups: Value) -> Value {
    json!({"update_timestamp":now_ms(),"groups":groups})
}

// Deployment exposes generated runtime files through release-local symlinks.
// POSIX rename replaces a symlink rather than its target, so resolve the
// destination first and atomically replace the file under runtime-state.
fn atomic_write_target(path: &Path) -> Result<PathBuf> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            let link =
                fs::read_link(path).with_context(|| format!("read symlink {}", path.display()))?;
            if link.is_absolute() {
                Ok(link)
            } else {
                let parent = path
                    .parent()
                    .ok_or_else(|| anyhow!("path has no parent: {}", path.display()))?;
                Ok(parent.join(link))
            }
        }
        Ok(_) => Ok(path.to_path_buf()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(path.to_path_buf()),
        Err(error) => Err(error).with_context(|| format!("inspect {}", path.display())),
    }
}

fn write_text_atomically(path: &Path, text: &str) -> Result<()> {
    let target = atomic_write_target(path)?;
    let parent = target
        .parent()
        .ok_or_else(|| anyhow!("path has no parent: {}", target.display()))?;
    fs::create_dir_all(parent)?;
    let name = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("output");
    let temporary = parent.join(format!(".{name}.{}.{}.tmp", process::id(), now_ms()));
    {
        let mut file =
            File::create(&temporary).with_context(|| format!("create {}", temporary.display()))?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
    }
    let mut last_error = None;
    for attempt in 0..8 {
        match fs::rename(&temporary, &target) {
            Ok(()) => return Ok(()),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::WouldBlock
                ) =>
            {
                last_error = Some(error);
                sleep(Duration::from_millis(20 * (attempt + 1) as u64));
            }
            Err(error) => {
                return Err(error).with_context(|| format!("replace {}", target.display()))
            }
        }
    }
    // DrvFS/NTFS may temporarily refuse replace while a reader holds the old
    // path. The final overwrite avoids a permanent stalled route lease.
    match fs::write(&target, text) {
        Ok(()) => {
            let _ = fs::remove_file(&temporary);
            Ok(())
        }
        Err(error) => {
            Err(last_error.unwrap_or(error)).with_context(|| format!("write {}", target.display()))
        }
    }
}

fn status_paths(root: &Path) -> (PathBuf, PathBuf, PathBuf, PathBuf, PathBuf, PathBuf) {
    (
        root.join("last-target-markets.json"),
        root.join("last-target-route.json"),
        root.join("last-target-lookup-tables.txt"),
        root.join("last-target-status.json"),
        root.join(".last-route-bridge-state.json"),
        root.join(".last-grpc-state.json"),
    )
}

fn heartbeat_active_markets_if_due(options: &Options, cache: &mut BridgeCache) -> Result<()> {
    if cache
        .last_markets_heartbeat
        .is_some_and(|last| last.elapsed() < ACTIVE_MARKETS_HEARTBEAT)
    {
        return Ok(());
    }
    let (markets_path, _, _, status_path, _, _) = status_paths(&options.root);
    let status = read_json_if_present(&status_path)?;
    if status.as_ref().and_then(|value| value.get("status")) != Some(&json!("active")) {
        return Ok(());
    }
    let markets = read_json_if_present(&markets_path)?
        .ok_or_else(|| anyhow!("active markets missing: {}", markets_path.display()))?;
    let groups = markets.get("groups").cloned().unwrap_or(Value::Null);
    if !usable_market_groups(Some(&groups)) {
        return Err(anyhow!(
            "active markets have no usable groups: {}",
            markets_path.display()
        ));
    }
    write_json_atomically(&markets_path, &notarb_markets_file(groups))?;
    cache.last_markets_heartbeat = Some(Instant::now());
    Ok(())
}

fn publish_status(path: &Path, status: Value) -> Result<bool> {
    let changed = read_json_if_present(path)?
        .map(|previous| {
            previous.get("fingerprint") != status.get("fingerprint")
                || previous.get("status") != status.get("status")
                || previous.get("reason") != status.get("reason")
                || value_path(&previous, &["activity", "signature"])
                    != value_path(&status, &["activity", "signature"])
                || value_path(&previous, &["activity", "observedAt"])
                    != value_path(&status, &["activity", "observedAt"])
                // A generic LAST signer heartbeat can stay the same while a
                // newly observed qualified route refreshes the evidence
                // fingerprint. Publish that transition too, otherwise the
                // supervisor would compare the new route file to stale status
                // evidence and stop its existing child.
                || value_path(&previous, &["activity", "routeEvidenceFingerprint"])
                    != value_path(&status, &["activity", "routeEvidenceFingerprint"])
                || value_path(&previous, &["observer", "lastRouteSignature"])
                    != value_path(&status, &["observer", "lastRouteSignature"])
                || previous.get("generation") != status.get("generation")
        })
        .unwrap_or(true);
    if changed {
        let mut body = Map::new();
        body.insert("schemaVersion".to_owned(), json!(1));
        body.insert("generatedAt".to_owned(), json!(now_iso()));
        if let Value::Object(status) = status {
            for (key, value) in status {
                body.insert(key, value);
            }
        }
        write_json_atomically(path, &Value::Object(body))?;
    }
    Ok(changed)
}

fn publish_no_route_evidence_status(
    options: &Options,
    status_path: &Path,
    events_file_present: bool,
) -> Result<()> {
    // Do not touch route, markets, bridge-state, or observer-state artifacts
    // here. A held status is enough for the lifecycle supervisor to stop a
    // previously managed child, while avoiding a fabricated active route when
    // the observer has not yielded one.
    let source = json!({
        "watchedAddress":WATCHED_ADDRESS,
        "signature":Value::Null,
        "slot":Value::Null,
        "observedAt":Value::Null,
    });
    let details = json!({
        "eventsPath":options.events.display().to_string(),
        "eventsFilePresent":events_file_present,
        "watchedAddress":WATCHED_ADDRESS,
    });
    let fingerprint = sha256(&json!({
        "status":"held",
        "reason":"no_route_evidence",
        "details":details,
    }));
    let status = json!({
        "status":"held",
        "reason":"no_route_evidence",
        "fingerprint":fingerprint,
        "source":source,
        "observer":{
            "lastObservedAt":Value::Null,
            "lastSignature":Value::Null,
            "lastSlot":Value::Null,
            "routeEvidenceFingerprint":Value::Null,
            "stale":true,
            "routeEvidencePresent":false,
        },
        "activity":Value::Null,
        "activeTarget":Value::Null,
        "details":details,
    });
    if publish_status(status_path, status)? {
        eprintln!(
            "{}",
            json!({
                "status":"target_route_held",
                "reason":"no_route_evidence",
                "eventsPath":options.events.display().to_string(),
                "eventsFilePresent":events_file_present,
            })
        );
    }
    Ok(())
}

fn publish_observer_state(
    path: &Path,
    activity: &Value,
    route: &Value,
    fingerprint: &str,
    stale: bool,
) -> Result<bool> {
    let changed = read_json_if_present(path)?
        .map(|previous| {
            previous.get("lastSignature") != activity.get("signature")
                || previous.get("lastObservedAt") != activity.get("observedAt")
                || previous.get("lastRouteSignature") != route.get("signature")
                || previous.get("lastRouteObservedAt") != route.get("observedAt")
                || previous.get("lastRouteFingerprint").and_then(Value::as_str) != Some(fingerprint)
                || previous.get("stale").and_then(Value::as_bool) != Some(stale)
        })
        .unwrap_or(true);
    if changed {
        write_json_atomically(path, &state_for(activity, route, fingerprint, stale))?;
    }
    Ok(changed)
}

// The derived market set can stay the same while the observed LAST route
// evidence changes (for example, the ALT selections or writable route
// accounts change).  In that case the active generation is intentionally
// preserved, but its route evidence must advance with the observer.  The
// lifecycle supervisor requires these values to agree before extending the
// active lease.
fn refresh_unchanged_route_automation(
    path: &Path,
    route_evidence_fingerprint: &str,
    observer_last_seen_at: Value,
) -> Result<bool> {
    let mut route = read_json_if_present(path)?
        .ok_or_else(|| anyhow!("active route missing: {}", path.display()))?;
    let automation = route
        .get_mut("automation")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("active route missing automation: {}", path.display()))?;
    let fingerprint_changed = automation.get("routeEvidenceFingerprint")
        != Some(&Value::String(route_evidence_fingerprint.to_owned()));
    let observed_at_changed = automation.get("observerLastSeenAt") != Some(&observer_last_seen_at);
    if !fingerprint_changed && !observed_at_changed {
        return Ok(false);
    }
    automation.insert(
        "routeEvidenceFingerprint".to_owned(),
        Value::String(route_evidence_fingerprint.to_owned()),
    );
    automation.insert("observerLastSeenAt".to_owned(), observer_last_seen_at);
    write_json_atomically(path, &route)?;
    Ok(true)
}

// `source` remains the route that created the derived market generation. A
// same-generation matched route can nevertheless refresh ALT indexes or route
// evidence. Preserve that newest validated evidence separately so a later
// generic signer activity can renew the lease without re-running route RPC.
fn refresh_bridge_state_route_evidence(
    path: &Path,
    bridge_state: &Value,
    event: &Value,
    route_evidence_fingerprint: &str,
) -> Result<Value> {
    let mut refreshed = bridge_state.clone();
    let state = refreshed
        .as_object_mut()
        .ok_or_else(|| anyhow!("invalid bridge state: {}", path.display()))?;
    let route_source = source_for(event);
    let desired = [
        (
            "lastValidatedRouteSignature",
            event.get("signature").cloned().unwrap_or(Value::Null),
        ),
        (
            "lastValidatedRouteSlot",
            event.get("slot").cloned().unwrap_or(Value::Null),
        ),
        (
            "lastValidatedRouteObservedAt",
            event.get("observedAt").cloned().unwrap_or(Value::Null),
        ),
        (
            "lastValidatedRouteEvidenceFingerprint",
            Value::String(route_evidence_fingerprint.to_owned()),
        ),
        ("lastValidatedRouteSource", route_source),
    ];
    let changed = desired
        .iter()
        .any(|(key, value)| state.get(*key) != Some(value));
    if changed {
        for (key, value) in desired {
            state.insert(key.to_owned(), value);
        }
        state.insert("updatedAt".to_owned(), Value::String(now_iso()));
        write_json_atomically(path, &refreshed)?;
    }
    Ok(refreshed)
}

fn usable_market_groups(groups: Option<&Value>) -> bool {
    groups.and_then(Value::as_array).is_some_and(|groups| {
        !groups.is_empty()
            && groups.iter().all(|group| {
                group.as_array().is_some_and(|addresses| {
                    addresses.len() >= 2
                        && addresses.iter().all(|address| {
                            address.as_str().is_some_and(|address| !address.is_empty())
                        })
                })
            })
    })
}

fn empty_array_or_missing(value: Option<&Value>) -> bool {
    match value.and_then(Value::as_array) {
        None => true,
        Some(items) => items.is_empty(),
    }
}

// Generic LAST-signed activity deliberately reuses the existing route. It
// must never cause a new route/ALT/pool derivation. Require that all persisted
// route artifacts still describe exactly the latest validated route evidence
// before issuing a renewed active lease.
fn retained_lease(
    route: &Value,
    markets: &Value,
    bridge_state: &Value,
    prior_status: &Value,
    route_event: &Value,
    route_evidence_fingerprint: &str,
) -> Option<RetainedLease> {
    let generation = bridge_state.get("generation").and_then(Value::as_u64)?;
    let active_fingerprint = bridge_state
        .get("activeFingerprint")
        .and_then(Value::as_str)?
        .to_owned();
    let source = bridge_state.get("source")?.clone();
    if bridge_state.get("lastValidatedRouteSignature") != route_event.get("signature")
        || value_path(bridge_state, &["lastValidatedRouteSource", "signature"])
            != route_event.get("signature")
        || bridge_state
            .get("lastValidatedRouteEvidenceFingerprint")
            .and_then(Value::as_str)
            != Some(route_evidence_fingerprint)
        || value_path(
            bridge_state,
            &["lastValidatedRouteSource", "watchedAddress"],
        )
        .and_then(Value::as_str)
            != Some(WATCHED_ADDRESS)
        || source.get("watchedAddress").and_then(Value::as_str) != Some(WATCHED_ADDRESS)
        || value_path(route, &["source", "watchedAddress"]).and_then(Value::as_str)
            != Some(WATCHED_ADDRESS)
        || prior_status.get("status").and_then(Value::as_str) != Some("active")
        || prior_status.get("generation").and_then(Value::as_u64) != Some(generation)
        || prior_status.get("fingerprint").and_then(Value::as_str)
            != Some(active_fingerprint.as_str())
        || value_path(prior_status, &["activity", "routeEvidenceFingerprint"])
            .and_then(Value::as_str)
            != Some(route_evidence_fingerprint)
        || value_path(prior_status, &["observer", "stale"]).and_then(Value::as_bool) != Some(false)
        || value_path(route, &["automation", "generation"]).and_then(Value::as_u64)
            != Some(generation)
        || value_path(route, &["automation", "fingerprint"]).and_then(Value::as_str)
            != Some(active_fingerprint.as_str())
        || value_path(route, &["automation", "routeEvidenceFingerprint"]).and_then(Value::as_str)
            != Some(route_evidence_fingerprint)
        || route.get("selectedGroups") != markets.get("groups")
        || !usable_market_groups(markets.get("groups"))
        || !empty_array_or_missing(route.get("unsupportedCandidateDexPrograms"))
        || !empty_array_or_missing(route.get("rejectedLookupTables"))
    {
        return None;
    }
    Some(RetainedLease {
        generation,
        active_fingerprint,
        source,
        groups: markets.get("groups")?.clone(),
    })
}

fn build(options: &Options) -> Result<()> {
    let mut cache = BridgeCache::default();
    build_with_cache(options, &mut cache)
}

fn build_with_cache(options: &Options, cache: &mut BridgeCache) -> Result<()> {
    let latest = load_latest_event_cached(options, cache)?;
    match latest {
        LatestEvent::NoRouteEvidence {
            events_file_present,
        } => {
            let input_key = format!("no_route_evidence:{events_file_present}");
            if cache.last_input_key.as_deref() == Some(input_key.as_str())
                && cache.last_input_stale.is_none()
            {
                return Ok(());
            }
            let (_, _, _, status_path, _, _) = status_paths(&options.root);
            let result =
                publish_no_route_evidence_status(options, &status_path, events_file_present);
            if result.is_ok() {
                cache.last_input_key = Some(input_key);
                cache.last_input_stale = None;
            }
            result
        }
        LatestEvent::Route(event) => {
            let route_evidence_fingerprint = json_route_evidence_fingerprint(&event);
            let activity_event =
                latest_activity(&event, load_last_signer_activity_cached(options, cache)?);
            let stale = event_is_stale(&activity_event, options.max_observer_staleness);
            let input_key = sha256(&json!({
                "routeEvidenceFingerprint":route_evidence_fingerprint,
                "routeSignature":event.get("signature").cloned().unwrap_or(Value::Null),
                "routeObservedAt":event.get("observedAt").cloned().unwrap_or(Value::Null),
                "activitySignature":activity_event.get("signature").cloned().unwrap_or(Value::Null),
                "activityObservedAt":activity_event.get("observedAt").cloned().unwrap_or(Value::Null),
            }));
            if cache.last_input_key.as_deref() == Some(input_key.as_str())
                && cache.last_input_stale == Some(stale)
            {
                if !stale {
                    heartbeat_active_markets_if_due(options, cache)?;
                }
                return Ok(());
            }
            let result = build_route(options, event, activity_event, stale);
            if result.is_ok() {
                cache.last_input_key = Some(input_key);
                cache.last_input_stale = Some(stale);
                cache.last_markets_heartbeat = Some(Instant::now());
            }
            result
        }
    }
}

fn build_route(options: &Options, event: Value, activity_event: Value, stale: bool) -> Result<()> {
    let (
        markets_path,
        route_path,
        lookup_path,
        status_path,
        bridge_state_path,
        observer_state_path,
    ) = status_paths(&options.root);
    let source = source_for(&event);
    let route_evidence_fingerprint = json_route_evidence_fingerprint(&event);
    let observer = observer_for(&activity_event, &event, &route_evidence_fingerprint, stale);
    let activity = json!({
        "signature":activity_event.get("signature").cloned().unwrap_or(Value::Null),
        "slot":activity_event.get("slot").cloned().unwrap_or(Value::Null),
        "observedAt":activity_event.get("observedAt").cloned().unwrap_or(Value::Null),
        "routeEvidenceFingerprint":route_evidence_fingerprint,
    });
    publish_observer_state(
        &observer_state_path,
        &activity_event,
        &event,
        &route_evidence_fingerprint,
        stale,
    )?;
    let bridge_state = read_json_if_present(&bridge_state_path)?;
    let active_target = bridge_state.as_ref().map(|state| {
        json!({
            "generation":state.get("generation").cloned().unwrap_or(Value::Null),
            "source":state.get("source").cloned().unwrap_or(Value::Null),
        })
    });
    let hold = |reason: &str, details: Value| -> Result<()> {
        let status_fingerprint =
            sha256(&json!({"status":"held","reason":reason,"source":source,"details":details}));
        let status = json!({
            "status":"held",
            "reason":reason,
            "fingerprint":status_fingerprint,
            "source":source,
            "observer":observer,
            "activity":activity,
            "activeTarget":active_target,
            "details":details,
        });
        if publish_status(&status_path, status)? {
            eprintln!(
                "{}",
                json!({"status":"target_route_held","reason":reason,"source":source,"details":details})
            );
        }
        Ok(())
    };
    if stale {
        return hold(
            "observer_stale",
            json!({"maxObserverStalenessMs":options.max_observer_staleness.as_millis()}),
        );
    }
    let activity_is_generic = activity_event.get("signature") != event.get("signature");
    if activity_is_generic {
        let route_is_current_generation = bridge_state
            .as_ref()
            .and_then(|state| state.get("lastValidatedRouteSignature"))
            == event.get("signature")
            && bridge_state
                .as_ref()
                .and_then(|state| state.get("lastValidatedRouteEvidenceFingerprint"))
                .and_then(Value::as_str)
                == Some(route_evidence_fingerprint.as_str());
        if route_is_current_generation {
            let lease = match (
                read_json_if_present(&route_path),
                read_json_if_present(&markets_path),
                read_json_if_present(&status_path),
                bridge_state.as_ref(),
            ) {
                (Ok(Some(route)), Ok(Some(markets)), Ok(Some(prior_status)), Some(state)) => {
                    retained_lease(
                        &route,
                        &markets,
                        state,
                        &prior_status,
                        &event,
                        &route_evidence_fingerprint,
                    )
                }
                _ => None,
            };
            let Some(lease) = lease else {
                return hold(
                    "validated_route_unavailable",
                    json!({
                        "activitySignature":activity_event.get("signature").cloned().unwrap_or(Value::Null),
                        "routeSignature":event.get("signature").cloned().unwrap_or(Value::Null),
                    }),
                );
            };
            // Do not regenerate route, ALT, or bridge state from a generic
            // transaction. It merely keeps the exact already-validated group
            // warm for NotArb and refreshes its market-file heartbeat.
            write_json_atomically(&markets_path, &notarb_markets_file(lease.groups))?;
            let status = json!({
                "status":"active",
                "reason":"last_signer_activity",
                "fingerprint":lease.active_fingerprint,
                "generation":lease.generation,
                "source":lease.source,
                "observer":observer,
                "activity":activity,
            });
            publish_status(&status_path, status)?;
            println!(
                "{}",
                json!({
                    "status":"target_activity_lease_extended",
                    "activitySignature":activity_event.get("signature").cloned().unwrap_or(Value::Null),
                    "routeSignature":event.get("signature").cloned().unwrap_or(Value::Null),
                    "generation":lease.generation,
                })
            );
            return Ok(());
        }
        // A newer qualifying route must still pass the normal validation path
        // below. A stale historical route may not be resurrected merely because
        // a later generic activity exists.
        if event_is_stale(&event, options.max_observer_staleness) {
            return hold(
                "validated_route_unavailable",
                json!({
                    "activitySignature":activity_event.get("signature").cloned().unwrap_or(Value::Null),
                    "routeSignature":event.get("signature").cloned().unwrap_or(Value::Null),
                    "reason":"route_evidence_stale_before_validation",
                }),
            );
        }
    }
    let unsupported = unsupported_dexes(&event);
    if !unsupported.is_empty() {
        return hold(
            "unsupported_candidate_dex",
            json!({"unsupportedCandidateDexPrograms":unsupported}),
        );
    }
    let candidate_markets = market_candidates(&event);
    if candidate_markets.source == "na_instruction_market_pairs"
        && candidate_markets.candidates.is_empty()
    {
        return hold(
            "missing_na_market_pairs",
            json!({
                "candidateDexPrograms":candidate_dexes(&event),
                "message":"expanded NA instruction accounts contained no writable supported DEX market-state at its required relative offset",
            }),
        );
    }
    let addresses = candidate_markets
        .candidates
        .iter()
        .map(|candidate| candidate.address.clone())
        .collect::<Vec<_>>();
    let accounts = rpc_accounts(&options.rpc_url, &addresses)?;
    let observed_alts = observed_alts(&event);
    let alt_accounts = if observed_alts.is_empty() {
        Vec::new()
    } else {
        rpc_accounts(&options.rpc_url, &observed_alts)?
    };
    let (lookup_tables, rejected_lookup_tables) = validate_alts(&alt_accounts);
    let targets = candidate_mints(&event);
    let pools = route_pools(&event, &candidate_markets.candidates, &accounts)?;
    if candidate_markets.source == "na_instruction_market_pairs"
        && pools.len() != candidate_markets.candidates.len()
    {
        return hold(
            "invalid_na_market_pair",
            json!({
                "candidateMarketCount":candidate_markets.candidates.len(),
                "validatedMarketCount":pools.len(),
                "candidateMarkets":candidate_markets.candidates.iter().map(|candidate| json!({
                    "address":candidate.address,
                    "dexProgramId":candidate.expected_program_id,
                    "dexProgramPosition":candidate.dex_program_position,
                    "marketPosition":candidate.market_position,
                    "marketOffset":candidate.market_offset,
                })).collect::<Vec<_>>(),
            }),
        );
    }
    let groups = market_groups(
        candidate_markets.source,
        &targets,
        &pools,
        options.max_markets,
    );
    if !rejected_lookup_tables.is_empty() {
        return hold(
            "unreadable_route_alt",
            json!({"observedLookupTables":observed_alts,"rejectedLookupTables":rejected_lookup_tables}),
        );
    }
    if groups.is_empty() {
        return hold(
            "insufficient_validated_pools",
            json!({
                "validatedPoolCount":pools.len(),
                "marketCandidateSource":candidate_markets.source,
                "candidateDexPrograms":candidate_dexes(&event),
                "observedLookupTables":observed_alts,
            }),
        );
    }
    let active_fingerprint = sha256(&json!({
        "targetMints":sorted_strings(targets.clone()),
        "candidateDexes":sorted_strings(candidate_dexes(&event).iter().filter_map(|item| item.get("programId").and_then(Value::as_str).map(ToOwned::to_owned))),
        "groups":groups,
        "lookupTables":lookup_tables,
    }));
    if bridge_state
        .as_ref()
        .and_then(|state| state.get("activeFingerprint"))
        .and_then(Value::as_str)
        == Some(&active_fingerprint)
    {
        // Refresh the route evidence before publishing active status for this
        // activity.  Keeping an old automation fingerprint here would make
        // the supervisor reject a fresh lease even though the markets did not
        // need a new generation.
        refresh_unchanged_route_automation(
            &route_path,
            &route_evidence_fingerprint,
            event.get("observedAt").cloned().unwrap_or(Value::Null),
        )?;
        let refreshed_bridge_state = refresh_bridge_state_route_evidence(
            &bridge_state_path,
            bridge_state
                .as_ref()
                .ok_or_else(|| anyhow!("missing bridge state for unchanged route"))?,
            &event,
            &route_evidence_fingerprint,
        )?;
        write_json_atomically(&markets_path, &notarb_markets_file(json!(groups)))?;
        let status = json!({
            "status":"active",
            "reason":"unchanged",
            "fingerprint":active_fingerprint,
            "generation":refreshed_bridge_state.get("generation").cloned().unwrap_or(json!(1)),
            "source":refreshed_bridge_state.get("source").cloned().unwrap_or(source),
            "observer":observer,
            "activity":activity,
        });
        publish_status(&status_path, status)?;
        return Ok(());
    }
    let generation = bridge_state
        .as_ref()
        .and_then(|state| state.get("generation"))
        .and_then(Value::as_u64)
        .unwrap_or(0)
        + 1;
    let lookup_text = [
        "# Generated by last-route-bridge (Rust) from one LAST gRPC route.".to_owned(),
        format!("# watched address: {WATCHED_ADDRESS}"),
        format!(
            "# source signature: {}",
            event
                .get("signature")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
        ),
        format!(
            "# source observed at: {}",
            event
                .get("observedAt")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
        ),
        format!("# target generation: {generation}"),
        "# These are currently valid, route-specific public ALT accounts.".to_owned(),
    ]
    .into_iter()
    .chain(lookup_tables.iter().cloned())
    .collect::<Vec<_>>()
    .join("\n")
        + "\n";
    write_text_atomically(&lookup_path, &lookup_text)?;
    let validated_markets = pools
        .iter()
        .map(|pool| {
            json!({
                "address":pool.address,
                "dexProgramId":pool.program_id,
                "dex":pool.label,
                "dataLength":pool.data_len,
                "targetMints":pool.target_mints,
                "containsWsol":pool.contains_wsol,
                "naInstructionReferences":na_instruction_market_references(&event, &pool.address),
            })
        })
        .collect::<Vec<_>>();
    let route = json!({
        "schemaVersion":1,
        "generatedAt":now_iso(),
        "source":{
            "type":"LAST Yellowstone gRPC evidence plus 82 read-RPC account ownership verification (Rust bridge)",
            "watchedAddress":WATCHED_ADDRESS,
            "signature":event.get("signature").cloned().unwrap_or(Value::Null),
            "slot":event.get("slot").cloned().unwrap_or(Value::Null),
            "observedAt":event.get("observedAt").cloned().unwrap_or(Value::Null),
        },
        "baseMint":WSOL_MINT,
        "targets":value_path(&event, &["arbitrageIntent", "mints"]).cloned().unwrap_or(json!([])),
        "candidateDexPrograms":candidate_dexes(&event),
        "unsupportedCandidateDexPrograms":[],
        "observedLookupTables":observed_alts,
        "selectedLookupTables":lookup_tables,
        "rejectedLookupTables":rejected_lookup_tables,
        "marketCandidateSource":candidate_markets.source,
        "validatedMarketStates":validated_markets.clone(),
        // Keep the previous names as a read-only compatibility alias for
        // existing route-inspection tooling. New consumers should use the
        // market-state fields above.
        "poolCandidateSource":candidate_markets.source,
        "validatedPoolStates":validated_markets,
        "selectedGroups":groups,
        "automation":{
            "mode":"auto_follow",
            "generation":generation,
            "fingerprint":active_fingerprint,
            "observerLastSeenAt":event.get("observedAt").cloned().unwrap_or(Value::Null),
            "bridgeIntervalMs":options.interval.as_millis(),
            "routeEvidenceFingerprint":route_evidence_fingerprint,
        },
    });
    write_json_atomically(&route_path, &route)?;
    write_json_atomically(&markets_path, &notarb_markets_file(json!(groups)))?;
    write_json_atomically(
        &bridge_state_path,
        &json!({
            "schemaVersion":1,
            "generation":generation,
            "activeFingerprint":active_fingerprint,
            "source":source,
            "lastValidatedRouteSignature":event.get("signature").cloned().unwrap_or(Value::Null),
            "lastValidatedRouteSlot":event.get("slot").cloned().unwrap_or(Value::Null),
            "lastValidatedRouteObservedAt":event.get("observedAt").cloned().unwrap_or(Value::Null),
            "lastValidatedRouteEvidenceFingerprint":route_evidence_fingerprint,
            "lastValidatedRouteSource":source_for(&event),
            "updatedAt":now_iso(),
        }),
    )?;
    let status = json!({
        "status":"active",
        "reason":"target_auto_follow",
        "fingerprint":active_fingerprint,
        "generation":generation,
        "source":source,
        "observer":observer,
        "activity":activity,
        "targetMints":targets,
        "candidateDexPrograms":candidate_dexes(&event),
        "lookupTables":lookup_tables,
        "pools":pools.iter().map(|pool| json!({"address":pool.address,"dex":pool.label,"containsWsol":pool.contains_wsol})).collect::<Vec<_>>(),
        "groups":groups,
    });
    publish_status(&status_path, status)?;
    println!(
        "{}",
        json!({
            "status":"target_route_switched",
            "engine":"rust",
            "generation":generation,
            "signature":event.get("signature").cloned().unwrap_or(Value::Null),
            "targetMints":targets,
            "candidateDexPrograms":candidate_dexes(&event),
            "lookupTables":lookup_tables,
            "pools":pools.iter().map(|pool| json!({"address":pool.address,"dex":pool.label,"containsWsol":pool.contains_wsol})).collect::<Vec<_>>(),
            "groups":groups,
        })
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static FIXTURE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn fixture_directory(name: &str) -> PathBuf {
        let sequence = FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        env::temp_dir().join(format!(
            "last-route-bridge-{name}-{}-{}-{sequence}",
            process::id(),
            now_ms()
        ))
    }

    fn offline_options(root: PathBuf, events: PathBuf) -> Options {
        Options {
            route_receipt: root.join("last-grpc-route.json"),
            activity: root.join("last-grpc-activity.json"),
            root,
            events,
            // A no-listener endpoint makes an accidental read-RPC call fail
            // deterministically. The no-evidence paths must return before it
            // is ever used.
            rpc_url: "http://127.0.0.1:1".to_owned(),
            interval: Duration::from_secs(5),
            max_observer_staleness: Duration::from_secs(30),
            once: true,
            max_markets: 4,
        }
    }

    fn fixture_route_event(signature: &str, observed_at: &str) -> Value {
        json!({
            "watch":{"address":WATCHED_ADDRESS},
            "success":true,
            "signature":signature,
            "slot":"1",
            "notArb":{"matched":true},
            "accountKeys":[{"pubkey":"fixture-pool","writable":true,"signer":false}],
            "arbitrageIntent":{
                "mints":[{"mint":WSOL_MINT}],
                "dexPrograms":[{"programId":POOL_LAYOUTS[0].program_id,"label":POOL_LAYOUTS[0].label}],
            },
            "execution":{"kind":"no_fill","invokedPrograms":[]},
            "addressLookupTables":[],
            "observedAt":observed_at,
        })
    }

    fn fixture_signer_activity(signature: &str, observed_at: &str) -> Value {
        json!({
            "schemaVersion":1,
            "kind":"last_signer_activity",
            "signature":signature,
            "slot":"2",
            "observedAt":observed_at,
            "success":true,
            "watch":{"address":WATCHED_ADDRESS,"feePayer":WATCHED_ADDRESS,"isSigner":true},
        })
    }

    fn assert_no_active_outputs(directory: &Path) {
        for name in [
            "last-target-markets.json",
            "last-target-route.json",
            "last-target-lookup-tables.txt",
            ".last-route-bridge-state.json",
            ".last-grpc-state.json",
        ] {
            assert!(
                !directory.join(name).exists(),
                "no route evidence must not write {name}"
            );
        }
    }

    #[test]
    fn recognizes_orca_whirlpool_pool_state() {
        let layout = find_layout("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc")
            .expect("Orca Whirlpool layout");
        assert_eq!(layout.label, "Orca Whirlpool");
        assert_eq!(layout.sizes, &[653]);
    }

    #[test]
    fn read_rpc_batches_at_fifty_and_merges_accounts_in_input_order() {
        let addresses = (0..101)
            .map(|index| format!("address-{index:03}"))
            .collect::<Vec<_>>();
        let batches = rpc_account_batches(&addresses).collect::<Vec<_>>();

        assert_eq!(
            batches.iter().map(|batch| batch.len()).collect::<Vec<_>>(),
            vec![50, 50, 1]
        );
        assert_eq!(
            batches
                .iter()
                .flat_map(|batch| batch.iter().cloned())
                .collect::<Vec<_>>(),
            addresses
        );

        // This mirrors rpc_accounts' serial extend without using a network:
        // each batch yields accounts in its response order, then the bridge
        // merges each completed batch before requesting the next one.
        let mut merged = Vec::new();
        for batch in rpc_account_batches(&addresses) {
            let values = batch
                .iter()
                .map(|address| {
                    json!({
                        "owner":format!("owner-{address}"),
                        "data":[BASE64.encode(address.as_bytes()), "base64"],
                    })
                })
                .collect::<Vec<_>>();
            merged.extend(decode_rpc_accounts(batch, &values));
        }
        assert_eq!(
            merged
                .iter()
                .map(|account| account.address.clone())
                .collect::<Vec<_>>(),
            addresses
        );
        assert_eq!(merged[0].data.as_deref(), Some(b"address-000".as_slice()));
        assert_eq!(merged[50].data.as_deref(), Some(b"address-050".as_slice()));
        assert_eq!(merged[100].data.as_deref(), Some(b"address-100".as_slice()));
    }

    #[test]
    fn market_candidates_follow_na_program_offsets_not_account_array_order() {
        // Deliberately scramble the JSON array. The bridge must use the
        // instruction-relative position fields, not the array order or the
        // unstable global accountIndex values.
        let event = json!({
            "accountKeys":[{"pubkey":"legacy-a"},{"pubkey":"legacy-b"}],
            "notArb":{"instructions":[{
                "index":2,
                "accounts":[
                    {"position":49,"accountIndex":149,"pubkey":"cpmm-market","source":"lookup_table","writable":true},
                    {"position":47,"accountIndex":147,"pubkey":POOL_LAYOUTS[2].program_id,"source":"lookup_table","writable":false},
                    {"position":48,"accountIndex":148,"pubkey":"cpmm-event-authority","source":"lookup_table","writable":false},
                    {"position":44,"accountIndex":144,"pubkey":"dlmm-market-c","source":"lookup_table","writable":true},
                    {"position":43,"accountIndex":143,"pubkey":POOL_LAYOUTS[3].program_id,"source":"lookup_table","writable":false},
                    {"position":36,"accountIndex":136,"pubkey":"orca-market","source":"lookup_table","writable":true},
                    {"position":35,"accountIndex":135,"pubkey":POOL_LAYOUTS[4].program_id,"source":"lookup_table","writable":false},
                    {"position":27,"accountIndex":127,"pubkey":"dlmm-market-b","source":"lookup_table","writable":true},
                    {"position":26,"accountIndex":126,"pubkey":POOL_LAYOUTS[3].program_id,"source":"lookup_table","writable":false},
                    {"position":18,"accountIndex":118,"pubkey":"dlmm-market-a","source":"lookup_table","writable":true},
                    {"position":17,"accountIndex":117,"pubkey":POOL_LAYOUTS[3].program_id,"source":"lookup_table","writable":false},
                    {"position":10,"accountIndex":110,"pubkey":"raydium-market","source":"lookup_table","writable":true},
                    {"position":9,"accountIndex":109,"pubkey":POOL_LAYOUTS[0].program_id,"source":"lookup_table","writable":false},
                    {"position":11,"accountIndex":111,"pubkey":"raydium-vault-not-a-market","source":"lookup_table","writable":true}
                ]
            }]}
        });

        let selection = market_candidates(&event);
        assert_eq!(selection.source, "na_instruction_market_pairs");
        assert_eq!(
            selection
                .candidates
                .iter()
                .map(|candidate| candidate.address.as_str())
                .collect::<Vec<_>>(),
            vec![
                "raydium-market",
                "dlmm-market-a",
                "dlmm-market-b",
                "orca-market",
                "dlmm-market-c",
                "cpmm-market",
            ]
        );
        assert_eq!(
            selection
                .candidates
                .iter()
                .map(|candidate| {
                    (
                        candidate.dex_program_position,
                        candidate.market_position,
                        candidate.market_offset,
                    )
                })
                .collect::<Vec<_>>(),
            vec![
                (Some(9), Some(10), Some(1)),
                (Some(17), Some(18), Some(1)),
                (Some(26), Some(27), Some(1)),
                (Some(35), Some(36), Some(1)),
                (Some(43), Some(44), Some(1)),
                (Some(47), Some(49), Some(2)),
            ]
        );
        assert!(selection
            .candidates
            .iter()
            .all(|candidate| candidate.address != "cpmm-event-authority"
                && candidate.address != "raydium-vault-not-a-market"));
        assert_eq!(
            na_instruction_market_references(&event, "cpmm-market"),
            vec![json!({
                "topLevelInstructionIndex":2,
                "dexProgramId":POOL_LAYOUTS[2].program_id,
                "dexProgramPosition":47,
                "marketPosition":49,
                "marketOffset":2,
                "accountIndex":149,
                "source":"lookup_table",
                "writable":true,
            })]
        );
    }

    #[test]
    fn fresh_na_vector_never_falls_back_to_legacy_accounts() {
        let fresh_without_markets = json!({
            "accountKeys":[{"pubkey":"legacy-pool"}],
            "notArb":{"instructions":[{"index":2,"accounts":[]}]}
        });
        let selection = market_candidates(&fresh_without_markets);
        assert_eq!(selection.source, "na_instruction_market_pairs");
        assert!(selection.candidates.is_empty());

        let legacy = json!({"accountKeys":[{"pubkey":"legacy-b"},{"pubkey":"legacy-a"}]});
        let selection = market_candidates(&legacy);
        assert_eq!(selection.source, "legacy_transaction_accounts");
        assert_eq!(
            selection
                .candidates
                .iter()
                .map(|candidate| candidate.address.as_str())
                .collect::<Vec<_>>(),
            vec!["legacy-a", "legacy-b"]
        );
    }

    #[test]
    fn na_instruction_groups_preserve_all_verified_markets_in_route_order() {
        let market = |address: &str, market_position: u64| Pool {
            address: address.to_owned(),
            program_id: "test-dex".to_owned(),
            label: "test market".to_owned(),
            data_len: 1,
            target_mints: Vec::new(),
            contains_wsol: false,
            instruction_index: Some(2),
            dex_program_position: Some(market_position - 1),
            market_position: Some(market_position),
            market_offset: Some(1),
        };
        let pools = vec![
            market("market-45", 44),
            market("market-19", 18),
            market("market-37", 36),
            market("market-11", 10),
            market("market-28", 27),
        ];
        let groups = market_groups("na_instruction_market_pairs", &[], &pools, 2);
        assert_eq!(
            groups,
            vec![vec![
                "market-11".to_owned(),
                "market-19".to_owned(),
                "market-28".to_owned(),
                "market-37".to_owned(),
                "market-45".to_owned(),
            ]]
        );
        let markets_file = notarb_markets_file(json!(groups));
        assert!(markets_file
            .get("update_timestamp")
            .and_then(Value::as_u64)
            .is_some());
        assert_eq!(
            markets_file.get("groups"),
            Some(&json!([[
                "market-11",
                "market-19",
                "market-28",
                "market-37",
                "market-45"
            ]]))
        );
    }

    #[test]
    fn group_prefers_two_or_more_direct_wsol_pools() {
        let mint = "TargetMint".to_owned();
        let pools = vec![
            Pool {
                address: "orca".to_owned(),
                program_id: "whirl".to_owned(),
                label: "Orca Whirlpool".to_owned(),
                data_len: 653,
                target_mints: vec![mint.clone()],
                contains_wsol: false,
                instruction_index: None,
                dex_program_position: None,
                market_position: None,
                market_offset: None,
            },
            Pool {
                address: "pump".to_owned(),
                program_id: "pamm".to_owned(),
                label: "Pump.fun AMM".to_owned(),
                data_len: 301,
                target_mints: vec![mint.clone()],
                contains_wsol: true,
                instruction_index: None,
                dex_program_position: None,
                market_position: None,
                market_offset: None,
            },
            Pool {
                address: "meteora".to_owned(),
                program_id: "dlmm".to_owned(),
                label: "Meteora DLMM".to_owned(),
                data_len: 904,
                target_mints: vec![mint.clone()],
                contains_wsol: true,
                instruction_index: None,
                dex_program_position: None,
                market_position: None,
                market_offset: None,
            },
        ];
        assert_eq!(
            market_groups("legacy_transaction_accounts", &[mint], &pools, 4),
            vec![vec!["meteora".to_owned(), "pump".to_owned()]]
        );
    }

    #[test]
    fn signer_activity_accepts_last_set_loaded_accounts_but_not_inbound_or_failed_records() {
        let valid = json!({
            "schemaVersion":1,
            "kind":"last_signer_activity",
            "signature":"set-loaded-accounts",
            "slot":"1",
            "observedAt":now_iso(),
            "success":true,
            "watch":{"address":WATCHED_ADDRESS,"feePayer":WATCHED_ADDRESS,"isSigner":true},
        });
        assert!(is_last_signer_activity(&valid));

        let mut inbound = valid.clone();
        inbound["watch"]["isSigner"] = json!(false);
        inbound["watch"]["feePayer"] = json!("another-fee-payer");
        assert!(!is_last_signer_activity(&inbound));

        let mut failed = valid;
        failed["success"] = json!(false);
        assert!(!is_last_signer_activity(&failed));
    }

    #[test]
    fn latest_signer_activity_renews_lease_without_replacing_route_evidence() {
        let route = json!({
            "signature":"validated-route",
            "slot":"1",
            "observedAt":"2020-01-01T00:00:00.000Z",
        });
        let activity = json!({
            "schemaVersion":1,
            "kind":"last_signer_activity",
            "signature":"set-loaded-accounts",
            "slot":"2",
            "observedAt":now_iso(),
            "success":true,
            "watch":{"address":WATCHED_ADDRESS,"feePayer":WATCHED_ADDRESS,"isSigner":true},
        });
        let selected = latest_activity(&route, Some(activity));
        assert_eq!(
            selected.get("signature"),
            Some(&json!("set-loaded-accounts"))
        );
        assert_eq!(route.get("signature"), Some(&json!("validated-route")));
    }

    #[test]
    fn status_updates_route_evidence_while_generic_activity_is_unchanged() {
        let directory = fixture_directory("generic-activity-route-refresh");
        fs::create_dir_all(&directory).expect("create fixture directory");
        let status_path = directory.join("last-target-status.json");
        let first = json!({
            "status":"active",
            "reason":"unchanged",
            "fingerprint":"same-derived-markets",
            "generation":1,
            "activity":{
                "signature":"set-loaded-accounts",
                "observedAt":"2026-07-22T00:00:00.000Z",
                "routeEvidenceFingerprint":"old-route-evidence",
            },
            "observer":{"lastRouteSignature":"old-route"},
        });
        assert!(publish_status(&status_path, first).expect("publish first status"));
        let refreshed = json!({
            "status":"active",
            "reason":"unchanged",
            "fingerprint":"same-derived-markets",
            "generation":1,
            "activity":{
                "signature":"set-loaded-accounts",
                "observedAt":"2026-07-22T00:00:00.000Z",
                "routeEvidenceFingerprint":"new-route-evidence",
            },
            "observer":{"lastRouteSignature":"new-route"},
        });
        assert!(publish_status(&status_path, refreshed).expect("publish refreshed status"));
        let stored = read_json_if_present(&status_path)
            .expect("read status")
            .expect("status exists");
        assert_eq!(
            value_path(&stored, &["activity", "routeEvidenceFingerprint"]),
            Some(&json!("new-route-evidence"))
        );
        fs::remove_dir_all(&directory).expect("remove fixture directory");
    }

    #[test]
    fn retained_lease_requires_exact_existing_validated_route() {
        let fingerprint = "route-evidence";
        let event = json!({"signature":"validated-route"});
        let route = json!({
            "source":{"watchedAddress":WATCHED_ADDRESS,"signature":"validated-route"},
            "automation":{
                "generation":3,
                "fingerprint":"derived-markets",
                "routeEvidenceFingerprint":fingerprint,
            },
            "selectedGroups":[["pool-a","pool-b"]],
            "unsupportedCandidateDexPrograms":[],
            "rejectedLookupTables":[],
        });
        let markets = json!({"groups":[["pool-a","pool-b"]]});
        let state = json!({
            "generation":3,
            "activeFingerprint":"derived-markets",
            "source":{"watchedAddress":WATCHED_ADDRESS,"signature":"validated-route"},
            "lastValidatedRouteSignature":"validated-route",
            "lastValidatedRouteEvidenceFingerprint":fingerprint,
            "lastValidatedRouteSource":{"watchedAddress":WATCHED_ADDRESS,"signature":"validated-route"},
        });
        let status = json!({
            "status":"active",
            "generation":3,
            "fingerprint":"derived-markets",
            "activity":{"routeEvidenceFingerprint":fingerprint},
            "observer":{"stale":false},
        });
        let lease = retained_lease(&route, &markets, &state, &status, &event, fingerprint)
            .expect("matching route may be renewed");
        assert_eq!(lease.generation, 3);
        assert_eq!(lease.groups, json!([["pool-a", "pool-b"]]));

        let newer_route = json!({"signature":"new-qualified-route"});
        assert!(
            retained_lease(&route, &markets, &state, &status, &newer_route, fingerprint).is_none(),
            "a generic activity must not renew a route after new evidence appears"
        );

        let mut mismatched_source = state;
        mismatched_source["lastValidatedRouteSource"]["signature"] = json!("wrong-route");
        assert!(
            retained_lease(
                &route,
                &markets,
                &mismatched_source,
                &status,
                &event,
                fingerprint,
            )
            .is_none(),
            "a generic activity must not renew a route with inconsistent validated source"
        );
    }

    #[test]
    fn generic_activity_only_renews_active_r2_lease_without_rewriting_route_or_alt() {
        let directory = fixture_directory("generic-retained-lease");
        fs::create_dir_all(&directory).expect("create fixture directory");
        let events = directory.join("last-grpc-events.jsonl");
        // This fixture performs several atomic writes before it exercises the
        // retained-lease path.  Keep its clock-based lease comfortably wider
        // than a slow debug test run; the production default remains 30 s.
        let mut options = offline_options(directory.clone(), events.clone());
        options.max_observer_staleness = Duration::from_secs(300);
        let route_one_observed = (Utc::now() - chrono::Duration::seconds(2))
            .to_rfc3339_opts(SecondsFormat::Millis, true);
        let route_two_observed = (Utc::now() - chrono::Duration::seconds(1))
            .to_rfc3339_opts(SecondsFormat::Millis, true);
        let route_one = fixture_route_event("route-r1", &route_one_observed);
        let route_two = fixture_route_event("route-r2", &route_two_observed);
        let route_evidence_fingerprint = json_route_evidence_fingerprint(&route_two);
        let groups = json!([["pool-a", "pool-b"]]);
        let active_fingerprint = "stable-derived-markets";

        fs::write(&events, format!("{}\n", route_two)).expect("write latest matched route");
        write_json_atomically(
            &directory.join("last-target-route.json"),
            &json!({
                "source":{
                    "watchedAddress":WATCHED_ADDRESS,
                    "signature":"route-r1",
                    "slot":"1",
                    "observedAt":route_one_observed,
                },
                "automation":{
                    "generation":7,
                    "fingerprint":active_fingerprint,
                    "routeEvidenceFingerprint":route_evidence_fingerprint,
                },
                "selectedGroups":groups,
                "unsupportedCandidateDexPrograms":[],
                "rejectedLookupTables":[],
            }),
        )
        .expect("write retained route");
        write_json_atomically(
            &directory.join("last-target-markets.json"),
            &json!({"update_timestamp":1,"groups":groups}),
        )
        .expect("write retained markets");
        fs::write(
            directory.join("last-target-lookup-tables.txt"),
            "route-r1-alt\n",
        )
        .expect("write retained lookup tables");
        let bridge_state_path = directory.join(".last-route-bridge-state.json");
        let bridge_state = json!({
            "schemaVersion":1,
            "generation":7,
            "activeFingerprint":active_fingerprint,
            "source":source_for(&route_one),
            "lastValidatedRouteSignature":"route-r1",
            "lastValidatedRouteSlot":"1",
            "lastValidatedRouteObservedAt":route_one_observed,
            "lastValidatedRouteEvidenceFingerprint":json_route_evidence_fingerprint(&route_one),
            "lastValidatedRouteSource":source_for(&route_one),
        });
        write_json_atomically(&bridge_state_path, &bridge_state).expect("write bridge state r1");
        let refreshed_state = refresh_bridge_state_route_evidence(
            &bridge_state_path,
            &bridge_state,
            &route_two,
            &route_evidence_fingerprint,
        )
        .expect("refresh same-generation route r2");
        assert_eq!(
            refreshed_state
                .get("source")
                .and_then(|source| source.get("signature")),
            Some(&json!("route-r1")),
            "derived generation keeps its original source"
        );
        assert_eq!(
            refreshed_state.get("lastValidatedRouteSignature"),
            Some(&json!("route-r2"))
        );
        write_json_atomically(
            &directory.join("last-target-status.json"),
            &json!({
                "status":"active",
                "reason":"unchanged",
                "fingerprint":active_fingerprint,
                "generation":7,
                "source":source_for(&route_one),
                "observer":{"stale":false,"lastRouteSignature":"route-r2"},
                "activity":{"signature":"prior-activity","observedAt":route_two_observed,"routeEvidenceFingerprint":route_evidence_fingerprint},
            }),
        )
        .expect("write active r2 status");
        let route_before =
            fs::read(directory.join("last-target-route.json")).expect("read route before");
        let lookup_before =
            fs::read(directory.join("last-target-lookup-tables.txt")).expect("read lookup before");
        let bridge_before = fs::read(&bridge_state_path).expect("read bridge state before");

        write_json_atomically(
            &options.activity,
            &fixture_signer_activity("set-loaded-r2", &now_iso()),
        )
        .expect("write generic activity");
        build(&options).expect("generic activity must not call offline RPC");

        assert_eq!(
            fs::read(directory.join("last-target-route.json")).expect("read route after"),
            route_before,
            "generic activity must not rewrite route"
        );
        assert_eq!(
            fs::read(directory.join("last-target-lookup-tables.txt")).expect("read lookup after"),
            lookup_before,
            "generic activity must not rewrite ALT file"
        );
        assert_eq!(
            fs::read(&bridge_state_path).expect("read bridge state after"),
            bridge_before,
            "generic activity must not rewrite bridge state"
        );
        let active_status = read_json_if_present(&directory.join("last-target-status.json"))
            .expect("read active status")
            .expect("active status exists");
        assert_eq!(active_status.get("status"), Some(&json!("active")));
        assert_eq!(
            value_path(&active_status, &["activity", "signature"]),
            Some(&json!("set-loaded-r2"))
        );
        assert_eq!(
            value_path(&active_status, &["observer", "stale"]),
            Some(&json!(false))
        );

        // Once the bridge has held the lease, later generic activity may not
        // resurrect the historical group. A fresh matched route is required.
        write_json_atomically(
            &directory.join("last-target-status.json"),
            &json!({
                "status":"held",
                "reason":"observer_stale",
                "fingerprint":active_fingerprint,
                "generation":7,
                "observer":{"stale":true},
                "activity":{"signature":"set-loaded-r2","observedAt":now_iso(),"routeEvidenceFingerprint":route_evidence_fingerprint},
            }),
        )
        .expect("write held status");
        let markets_before_held_generic = fs::read(directory.join("last-target-markets.json"))
            .expect("read markets before held generic");
        write_json_atomically(
            &options.activity,
            &fixture_signer_activity("set-loaded-after-held", &now_iso()),
        )
        .expect("write generic activity after held");
        build(&options).expect("held generic activity must not call offline RPC");
        let held_status = read_json_if_present(&directory.join("last-target-status.json"))
            .expect("read held status")
            .expect("held status exists");
        assert_eq!(held_status.get("status"), Some(&json!("held")));
        assert_eq!(
            held_status.get("reason"),
            Some(&json!("validated_route_unavailable"))
        );
        assert_eq!(
            fs::read(directory.join("last-target-markets.json"))
                .expect("read markets after held generic"),
            markets_before_held_generic,
            "held generic activity must not heartbeat old markets"
        );
        assert_eq!(
            fs::read(directory.join("last-target-route.json")).expect("read held route"),
            route_before
        );
        assert_eq!(
            fs::read(directory.join("last-target-lookup-tables.txt")).expect("read held lookup"),
            lookup_before
        );
        assert_eq!(
            fs::read(&bridge_state_path).expect("read held bridge state"),
            bridge_before
        );
        fs::remove_dir_all(&directory).expect("remove fixture directory");
    }

    #[cfg(unix)]
    #[test]
    fn atomic_writer_preserves_release_to_runtime_symlink() {
        let directory = fixture_directory("runtime-symlink");
        let release = directory.join("release");
        let runtime = directory.join("runtime-state");
        fs::create_dir_all(&release).expect("create release directory");
        fs::create_dir_all(&runtime).expect("create runtime directory");
        let target = runtime.join("last-target-status.json");
        fs::write(&target, "{\"old\":true}\n").expect("write old runtime state");
        let release_path = release.join("last-target-status.json");
        std::os::unix::fs::symlink(&target, &release_path).expect("create release symlink");

        write_json_atomically(&release_path, &json!({"new":true}))
            .expect("write through release symlink");

        assert!(
            fs::symlink_metadata(&release_path)
                .expect("inspect release path")
                .file_type()
                .is_symlink(),
            "atomic replacement must retain the release symlink"
        );
        let persisted = read_json_if_present(&target)
            .expect("read runtime target")
            .expect("runtime target exists");
        assert_eq!(persisted.get("new"), Some(&json!(true)));
        fs::remove_dir_all(&directory).expect("remove fixture directory");
    }

    #[test]
    fn unchanged_generation_refreshes_route_evidence_atomically() {
        let directory = env::temp_dir().join(format!(
            "last-route-bridge-refresh-{}-{}",
            process::id(),
            now_ms()
        ));
        fs::create_dir_all(&directory).expect("create fixture directory");
        let route_path = directory.join("last-target-route.json");
        let original = json!({
            "source":{"signature":"prior-source"},
            "automation":{
                "generation":3,
                "fingerprint":"stable-derived-markets",
                "routeEvidenceFingerprint":"prior-route-evidence",
                "observerLastSeenAt":"2026-07-21T05:15:39.080Z"
            }
        });
        write_json_atomically(&route_path, &original).expect("write initial route");

        assert!(refresh_unchanged_route_automation(
            &route_path,
            "fresh-route-evidence",
            json!("2026-07-21T05:17:57.570Z"),
        )
        .expect("refresh unchanged route"));

        let refreshed = read_json_if_present(&route_path)
            .expect("read refreshed route")
            .expect("refreshed route exists");
        assert_eq!(
            value_path(&refreshed, &["automation", "generation"]),
            Some(&json!(3))
        );
        assert_eq!(
            value_path(&refreshed, &["automation", "fingerprint"]),
            Some(&json!("stable-derived-markets"))
        );
        assert_eq!(
            value_path(&refreshed, &["automation", "routeEvidenceFingerprint"]),
            Some(&json!("fresh-route-evidence"))
        );
        assert_eq!(
            value_path(&refreshed, &["automation", "observerLastSeenAt"]),
            Some(&json!("2026-07-21T05:17:57.570Z"))
        );
        assert_eq!(
            value_path(&refreshed, &["source", "signature"]),
            Some(&json!("prior-source"))
        );
        assert!(!refresh_unchanged_route_automation(
            &route_path,
            "fresh-route-evidence",
            json!("2026-07-21T05:17:57.570Z"),
        )
        .expect("unchanged refresh is a no-op"));
        fs::remove_dir_all(&directory).expect("remove fixture directory");
    }

    #[test]
    fn missing_events_publish_held_no_route_evidence_once_without_active_outputs() {
        let directory = fixture_directory("missing-events");
        fs::create_dir_all(&directory).expect("create fixture directory");
        let events = directory.join("last-grpc-events.jsonl");
        let options = offline_options(directory.clone(), events.clone());

        build(&options).expect("missing events are a held state, not an error");
        let first_status = read_json_if_present(&directory.join("last-target-status.json"))
            .expect("read held status")
            .expect("held status exists");
        assert_eq!(first_status.get("status"), Some(&json!("held")));
        assert_eq!(
            first_status.get("reason"),
            Some(&json!("no_route_evidence"))
        );
        assert_eq!(
            value_path(&first_status, &["details", "eventsPath"]),
            Some(&json!(events.display().to_string()))
        );
        assert_eq!(
            value_path(&first_status, &["details", "eventsFilePresent"]),
            Some(&json!(false))
        );
        assert_eq!(first_status.get("activity"), Some(&Value::Null));
        assert_no_active_outputs(&directory);

        // Repeating the idle tick must neither issue a read-RPC request nor
        // churn status generatedAt/fingerprint every interval.
        build(&options).expect("repeated missing events stay held");
        let second_status = read_json_if_present(&directory.join("last-target-status.json"))
            .expect("read repeated held status")
            .expect("repeated held status exists");
        assert_eq!(first_status, second_status);
        assert_no_active_outputs(&directory);
        fs::remove_dir_all(&directory).expect("remove fixture directory");
    }

    #[test]
    fn route_receipt_is_authoritative_over_malformed_historical_jsonl() {
        let directory = fixture_directory("receipt-priority");
        fs::create_dir_all(&directory).expect("create fixture directory");
        let events = directory.join("last-grpc-events.jsonl");
        // This completed malformed line would be a bridge error if the
        // implementation scanned historical JSONL before the latest receipt.
        fs::write(&events, "{malformed-json}\n").expect("write malformed history");
        let options = offline_options(directory.clone(), events);
        let receipt = fixture_route_event("receipt-route", "2020-01-01T00:00:00.000Z");
        write_json_atomically(&options.route_receipt, &receipt).expect("write route receipt");

        let mut cache = BridgeCache::default();
        build_with_cache(&options, &mut cache).expect("receipt avoids JSONL scan");

        let status = read_json_if_present(&directory.join("last-target-status.json"))
            .expect("read held status")
            .expect("held status exists");
        assert_eq!(status.get("status"), Some(&json!("held")));
        assert_eq!(status.get("reason"), Some(&json!("observer_stale")));
        assert_eq!(
            value_path(&status, &["source", "signature"]),
            Some(&json!("receipt-route"))
        );
        fs::remove_dir_all(&directory).expect("remove fixture directory");
    }

    #[test]
    fn malformed_route_receipt_holds_without_reviving_valid_history() {
        let directory = fixture_directory("malformed-receipt");
        fs::create_dir_all(&directory).expect("create fixture directory");
        let events = directory.join("last-grpc-events.jsonl");
        let options = offline_options(directory.clone(), events.clone());
        let history = fixture_route_event("historical-route", &now_iso());
        fs::write(&events, format!("{history}\n")).expect("write valid historical route");
        // A completed bad receipt must hold. Falling back to `history` would
        // attempt the offline RPC endpoint and accidentally reactivate it.
        fs::write(&options.route_receipt, "{partial-receipt\n")
            .expect("write malformed route receipt");

        let mut cache = BridgeCache::default();
        build_with_cache(&options, &mut cache).expect("malformed receipt holds safely");

        let status = read_json_if_present(&directory.join("last-target-status.json"))
            .expect("read held status")
            .expect("held status exists");
        assert_eq!(status.get("status"), Some(&json!("held")));
        assert_eq!(status.get("reason"), Some(&json!("no_route_evidence")));
        assert_no_active_outputs(&directory);
        fs::remove_dir_all(&directory).expect("remove fixture directory");
    }

    #[test]
    fn unchanged_route_receipt_does_not_churn_outputs_on_short_ticks() {
        let directory = fixture_directory("receipt-cache");
        fs::create_dir_all(&directory).expect("create fixture directory");
        let events = directory.join("last-grpc-events.jsonl");
        let options = offline_options(directory.clone(), events);
        let receipt = fixture_route_event("receipt-cache-route", "2020-01-01T00:00:00.000Z");
        write_json_atomically(&options.route_receipt, &receipt).expect("write route receipt");

        let mut cache = BridgeCache::default();
        build_with_cache(&options, &mut cache).expect("first receipt build");
        let status_path = directory.join("last-target-status.json");
        let first = fs::read(&status_path).expect("read first status");
        build_with_cache(&options, &mut cache).expect("unchanged receipt build");
        let second = fs::read(&status_path).expect("read second status");
        assert_eq!(
            first, second,
            "an unchanged receipt must not rewrite status on every 250 ms tick"
        );
        fs::remove_dir_all(&directory).expect("remove fixture directory");
    }

    #[test]
    fn active_market_heartbeat_refreshes_only_when_due() {
        let directory = fixture_directory("markets-heartbeat");
        fs::create_dir_all(&directory).expect("create fixture directory");
        let events = directory.join("last-grpc-events.jsonl");
        let options = offline_options(directory.clone(), events);
        let (markets_path, _, _, status_path, _, _) = status_paths(&directory);
        write_json_atomically(&status_path, &json!({"status":"active"}))
            .expect("write active status");
        write_json_atomically(
            &markets_path,
            &json!({"update_timestamp":1,"groups":[["pool-a","pool-b"]]}),
        )
        .expect("write active markets");

        let mut cache = BridgeCache {
            last_markets_heartbeat: Some(Instant::now() - ACTIVE_MARKETS_HEARTBEAT),
            ..BridgeCache::default()
        };
        let before = fs::read(&markets_path).expect("read markets before heartbeat");
        heartbeat_active_markets_if_due(&options, &mut cache).expect("refresh active heartbeat");
        let refreshed = fs::read(&markets_path).expect("read refreshed markets");
        assert_ne!(
            before, refreshed,
            "due heartbeat must rewrite markets timestamp"
        );
        let parsed = read_json_if_present(&markets_path)
            .expect("parse refreshed markets")
            .expect("refreshed markets exist");
        assert_eq!(parsed.get("groups"), Some(&json!([["pool-a", "pool-b"]])));
        assert!(parsed
            .get("update_timestamp")
            .and_then(Value::as_u64)
            .is_some_and(|timestamp| timestamp > 1));

        heartbeat_active_markets_if_due(&options, &mut cache).expect("short tick is a no-op");
        assert_eq!(
            refreshed,
            fs::read(&markets_path).expect("read markets after short tick"),
            "short ticks must not churn the markets file"
        );
        fs::remove_dir_all(&directory).expect("remove fixture directory");
    }

    #[test]
    fn jsonl_fallback_rechecks_when_the_route_receipt_is_missing() {
        let directory = fixture_directory("jsonl-fallback-refresh");
        fs::create_dir_all(&directory).expect("create fixture directory");
        let events = directory.join("last-grpc-events.jsonl");
        let options = offline_options(directory.clone(), events.clone());
        let first = fixture_route_event("jsonl-route-one", "2020-01-01T00:00:00.000Z");
        let second = fixture_route_event("jsonl-route-two", "2020-01-01T00:00:01.000Z");
        fs::write(&events, format!("{first}\n")).expect("write first route evidence");

        let mut cache = BridgeCache::default();
        build_with_cache(&options, &mut cache).expect("first JSONL fallback build");
        let status_path = directory.join("last-target-status.json");
        let first_status = read_json_if_present(&status_path)
            .expect("read first status")
            .expect("first status exists");
        assert_eq!(
            value_path(&first_status, &["source", "signature"]),
            Some(&json!("jsonl-route-one"))
        );

        // No compact receipt exists yet, so an appended JSONL route must not
        // be masked by the receipt-cache fast path.
        fs::write(&events, format!("{first}\n{second}\n")).expect("append second route evidence");
        build_with_cache(&options, &mut cache).expect("refreshed JSONL fallback build");
        let second_status = read_json_if_present(&status_path)
            .expect("read refreshed status")
            .expect("refreshed status exists");
        assert_eq!(
            value_path(&second_status, &["source", "signature"]),
            Some(&json!("jsonl-route-two"))
        );
        fs::remove_dir_all(&directory).expect("remove fixture directory");
    }

    #[test]
    fn non_qualifying_jsonl_event_is_held_without_active_route_or_read_rpc() {
        let directory = fixture_directory("no-route-evidence");
        fs::create_dir_all(&directory).expect("create fixture directory");
        let events = directory.join("last-grpc-events.jsonl");
        // The watched address is present, but the observer did not classify
        // this record as matched NotArb route evidence.
        fs::write(
            &events,
            format!(
                "{}\n",
                json!({
                    "watch":{"address":WATCHED_ADDRESS},
                    "success":true,
                    "notArb":{"matched":false},
                    "accountKeys":[{"pubkey":"not-a-pool","writable":true}],
                    "arbitrageIntent":{
                        "mints":[{"mint":WSOL_MINT}],
                        "dexPrograms":[{"programId":POOL_LAYOUTS[0].program_id}],
                    },
                })
            ),
        )
        .expect("write non-route fixture event");
        let options = offline_options(directory.clone(), events);

        build(&options).expect("non-route evidence is a held state, not an RPC error");
        let status = read_json_if_present(&directory.join("last-target-status.json"))
            .expect("read held status")
            .expect("held status exists");
        assert_eq!(status.get("status"), Some(&json!("held")));
        assert_eq!(status.get("reason"), Some(&json!("no_route_evidence")));
        assert_eq!(
            value_path(&status, &["details", "eventsFilePresent"]),
            Some(&json!(true))
        );
        assert_eq!(
            value_path(&status, &["observer", "routeEvidencePresent"]),
            Some(&json!(false))
        );
        assert_no_active_outputs(&directory);
        fs::remove_dir_all(&directory).expect("remove fixture directory");
    }

    #[test]
    fn signer_activity_without_route_evidence_stays_held_without_read_rpc() {
        let directory = fixture_directory("activity-without-route");
        fs::create_dir_all(&directory).expect("create fixture directory");
        let events = directory.join("last-grpc-events.jsonl");
        let options = offline_options(directory.clone(), events.clone());
        fs::write(
            &events,
            format!(
                "{}\n",
                json!({
                    "watch":{"address":WATCHED_ADDRESS},
                    "success":true,
                    "notArb":{"matched":false},
                    "accountKeys":[],
                    "arbitrageIntent":{"mints":[],"dexPrograms":[]},
                })
            ),
        )
        .expect("write non-route event");
        write_json_atomically(
            &options.activity,
            &json!({
                "schemaVersion":1,
                "kind":"last_signer_activity",
                "signature":"set-loaded-accounts",
                "slot":"1",
                "observedAt":now_iso(),
                "success":true,
                "watch":{"address":WATCHED_ADDRESS,"feePayer":WATCHED_ADDRESS,"isSigner":true},
            }),
        )
        .expect("write signer activity");

        build(&options).expect("activity without a route is held, not an RPC error");
        let status = read_json_if_present(&directory.join("last-target-status.json"))
            .expect("read held status")
            .expect("held status exists");
        assert_eq!(status.get("status"), Some(&json!("held")));
        assert_eq!(status.get("reason"), Some(&json!("no_route_evidence")));
        assert_no_active_outputs(&directory);
        fs::remove_dir_all(&directory).expect("remove fixture directory");
    }
}

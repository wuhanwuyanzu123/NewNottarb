use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::{SecondsFormat, Utc};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    env,
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    process,
    thread::sleep,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const WATCHED_ADDRESS: &str = "LASTvjDWkbXM1RwUCiniHqGLSEH5xJinDRs56wNPQr9";
const WSOL_MINT: &str = "So11111111111111111111111111111111111111112";
const ADDRESS_LOOKUP_TABLE_PROGRAM: &str = "AddressLookupTab1e1111111111111111111111111";
// The bridge read RPC rejects getMultipleAccounts payloads above 50 addresses.
// Keep this read-path ceiling separate from any send-path limits.
const MAX_GET_MULTIPLE_ACCOUNTS_ADDRESSES: usize = 50;

#[derive(Clone, Copy)]
struct PoolLayout {
    program_id: &'static str,
    label: &'static str,
    sizes: &'static [usize],
}

const POOL_LAYOUTS: &[PoolLayout] = &[
    PoolLayout {
        program_id: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
        label: "Raydium AMM v4",
        sizes: &[752],
    },
    PoolLayout {
        program_id: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
        label: "Pump.fun AMM",
        sizes: &[301],
    },
    PoolLayout {
        program_id: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
        label: "Meteora CPMM",
        sizes: &[1112],
    },
    PoolLayout {
        program_id: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
        label: "Meteora DLMM",
        sizes: &[904],
    },
    // Orca Whirlpool::LEN is 653 bytes (including Anchor discriminator).
    PoolLayout {
        program_id: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
        label: "Orca Whirlpool",
        sizes: &[653],
    },
];

#[derive(Debug)]
struct Options {
    root: PathBuf,
    events: PathBuf,
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
enum LatestEvent {
    Route(Value),
    NoRouteEvidence { events_file_present: bool },
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
    loop {
        if let Err(error) = build(&options) {
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
        5_000,
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

fn load_latest_event(path: &Path) -> Result<LatestEvent> {
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

fn route_pools(event: &Value, accounts: &[Account]) -> Result<Vec<Pool>> {
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
    for account in accounts {
        let Some(owner) = account.owner.as_deref() else {
            continue;
        };
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
        if target_mints.is_empty() {
            continue;
        }
        pools.push(Pool {
            address: account.address.clone(),
            program_id: owner.to_owned(),
            label: layout.label.to_owned(),
            data_len: data.len(),
            target_mints,
            contains_wsol: contains(data, &wsol),
        });
    }
    Ok(pools)
}

fn contains(data: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && data.windows(needle.len()).any(|window| window == needle)
}

fn market_groups(targets: &[String], pools: &[Pool], max_markets: usize) -> Vec<Vec<String>> {
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
    let (
        markets_path,
        route_path,
        lookup_path,
        status_path,
        bridge_state_path,
        observer_state_path,
    ) = status_paths(&options.root);
    let event = match load_latest_event(&options.events)? {
        LatestEvent::Route(event) => event,
        LatestEvent::NoRouteEvidence {
            events_file_present,
        } => {
            publish_no_route_evidence_status(options, &status_path, events_file_present)?;
            return Ok(());
        }
    };
    let source = source_for(&event);
    let route_evidence_fingerprint = json_route_evidence_fingerprint(&event);
    // A latest LAST-signed activity can be a housekeeping instruction (for
    // example setLoadedAccounts) which contains no route metadata. It renews
    // only the lifecycle lease; the route below remains the last fully
    // validated matched NotArb route.
    let activity_event = latest_activity(&event, load_last_signer_activity(&options.activity)?);
    let stale = event_is_stale(&activity_event, options.max_observer_staleness);
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
            write_json_atomically(
                &markets_path,
                &json!({"update_timestamp":now_ms(),"groups":lease.groups}),
            )?;
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
    let mut unique = BTreeSet::new();
    for key in event
        .get("accountKeys")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(address) = key.get("pubkey").and_then(Value::as_str) {
            unique.insert(address.to_owned());
        }
    }
    let addresses = unique.into_iter().collect::<Vec<_>>();
    let accounts = rpc_accounts(&options.rpc_url, &addresses)?;
    let observed_alts = observed_alts(&event);
    let alt_accounts = if observed_alts.is_empty() {
        Vec::new()
    } else {
        rpc_accounts(&options.rpc_url, &observed_alts)?
    };
    let (lookup_tables, rejected_lookup_tables) = validate_alts(&alt_accounts);
    let targets = candidate_mints(&event);
    let pools = route_pools(&event, &accounts)?;
    let groups = market_groups(&targets, &pools, options.max_markets);
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
        write_json_atomically(
            &markets_path,
            &json!({"update_timestamp":now_ms(),"groups":groups}),
        )?;
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
        "validatedPoolStates":pools.iter().map(|pool| json!({
            "address":pool.address,
            "dexProgramId":pool.program_id,
            "dex":pool.label,
            "dataLength":pool.data_len,
            "targetMints":pool.target_mints,
            "containsWsol":pool.contains_wsol,
        })).collect::<Vec<_>>(),
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
    write_json_atomically(
        &markets_path,
        &json!({"update_timestamp":now_ms(),"groups":groups}),
    )?;
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

    fn fixture_directory(name: &str) -> PathBuf {
        env::temp_dir().join(format!(
            "last-route-bridge-{name}-{}-{}",
            process::id(),
            now_ms()
        ))
    }

    fn offline_options(root: PathBuf, events: PathBuf) -> Options {
        Options {
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
            },
            Pool {
                address: "pump".to_owned(),
                program_id: "pamm".to_owned(),
                label: "Pump.fun AMM".to_owned(),
                data_len: 301,
                target_mints: vec![mint.clone()],
                contains_wsol: true,
            },
            Pool {
                address: "meteora".to_owned(),
                program_id: "dlmm".to_owned(),
                label: "Meteora DLMM".to_owned(),
                data_len: 904,
                target_mints: vec![mint.clone()],
                contains_wsol: true,
            },
        ];
        assert_eq!(
            market_groups(&[mint], &pools, 4),
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
        let options = offline_options(directory.clone(), events.clone());
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

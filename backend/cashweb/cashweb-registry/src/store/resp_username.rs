//! Redis RESP protocol store for clustered username uniqueness and atomic CAS tombstones.
//!
//! Connects to Apache Kvrocks (port 6666) or Redis-XC (port 6379) using the Redis RESP protocol.
//! Executes atomic conditional operations (CAS) via Lua scripts to prevent double-claims
//! across distributed relay instances without cross-node race conditions.

use std::sync::{Arc, Mutex};

use bitcoinsuite_error::Result;

use super::directory_usernames::{
    DbDirectoryUsernames, UsernameClaimResult, UsernameError, UsernameRecord, UsernameStatus,
    UsernameStore,
};

/// Key prefix for routable usernames in Redis / Kvrocks.
pub const USERNAME_KEY_PREFIX: &str = "username:";

/// Lua script for atomic username claim and conditional update.
pub const LUA_CLAIM_SCRIPT: &str = r#"
local key = KEYS[1]
local req_addr = cjson.decode(ARGV[1])
local now_ms = tonumber(ARGV[2])
local new_json = ARGV[3]
local updated_json = ARGV[4]

local function is_same_addr(a1, a2)
    if not a1 or not a2 or #a1 ~= #a2 then return false end
    for i = 1, #a1 do
        if a1[i] ~= a2[i] then return false end
    end
    return true
end

local function to_hex(arr)
    if not arr then return "" end
    local hex_digits = "0123456789abcdef"
    local hex = ""
    for i = 1, #arr do
        local b = arr[i]
        local hi = math.floor(b / 16) + 1
        local lo = (b % 16) + 1
        hex = hex .. hex_digits:sub(hi, hi) .. hex_digits:sub(lo, lo)
    end
    return hex
end

local existing = redis.call('GET', key)
if not existing then
    redis.call('SET', key, new_json)
    return {"OK", "CLAIMED"}
end

local decoded = cjson.decode(existing)
if decoded.status == "Active" then
    if is_same_addr(decoded.account_address, req_addr) then
        redis.call('SET', key, updated_json)
        return {"OK", "ALREADY_OWNED"}
    else
        return {"ERR_COLLISION", to_hex(decoded.account_address)}
    end
elseif decoded.status == "Tombstoned" or decoded.status == "Moved" then
    local expires_at = tonumber(decoded.tombstone_expires_at_ms) or 0
    if now_ms < expires_at then
        return {"ERR_TOMBSTONED", tostring(expires_at)}
    else
        redis.call('SET', key, new_json)
        return {"OK", "CLAIMED"}
    end
else
    redis.call('SET', key, new_json)
    return {"OK", "CLAIMED"}
end
"#;

/// Lua script for atomic username tombstoning.
pub const LUA_TOMBSTONE_SCRIPT: &str = r#"
local key = KEYS[1]
local req_addr = cjson.decode(ARGV[1])
local now_ms = tonumber(ARGV[2])
local cooldown_ms = tonumber(ARGV[3])
local tombstone_json = ARGV[4]

local function is_same_addr(a1, a2)
    if not a1 or not a2 or #a1 ~= #a2 then return false end
    for i = 1, #a1 do
        if a1[i] ~= a2[i] then return false end
    end
    return true
end

local existing = redis.call('GET', key)
if not existing then
    return 0
end

local decoded = cjson.decode(existing)
if not is_same_addr(decoded.account_address, req_addr) then
    return 0
end

redis.call('SET', key, tombstone_json)
if cooldown_ms > 0 then
    redis.call('PEXPIRE', key, cooldown_ms)
end
return 1
"#;

/// Lua script for atomic cross-key username rename.
pub const LUA_RENAME_SCRIPT: &str = r#"
local old_key = KEYS[1]
local new_key = KEYS[2]
local req_addr = cjson.decode(ARGV[1])
local now_ms = tonumber(ARGV[2])
local cooldown_ms = tonumber(ARGV[3])
local new_record_json = ARGV[4]
local moved_record_json = ARGV[5]

local function is_same_addr(a1, a2)
    if not a1 or not a2 or #a1 ~= #a2 then return false end
    for i = 1, #a1 do
        if a1[i] ~= a2[i] then return false end
    end
    return true
end

local function to_hex(arr)
    if not arr then return "" end
    local hex_digits = "0123456789abcdef"
    local hex = ""
    for i = 1, #arr do
        local b = arr[i]
        local hi = math.floor(b / 16) + 1
        local lo = (b % 16) + 1
        hex = hex .. hex_digits:sub(hi, hi) .. hex_digits:sub(lo, lo)
    end
    return hex
end

-- 1. Verify old_key exists and is owned by caller
local old_raw = redis.call('GET', old_key)
if not old_raw then
    return {"ERR_OLD_NOT_FOUND", ""}
end

local old_rec = cjson.decode(old_raw)
if not is_same_addr(old_rec.account_address, req_addr) then
    return {"ERR_OLD_COLLISION", to_hex(old_rec.account_address)}
end

-- 2. Verify new_key has no collision or active tombstone
local new_raw = redis.call('GET', new_key)
if new_raw then
    local new_rec = cjson.decode(new_raw)
    if new_rec.status == "Active" then
        if not is_same_addr(new_rec.account_address, req_addr) then
            return {"ERR_NEW_COLLISION", to_hex(new_rec.account_address)}
        end
    elseif new_rec.status == "Tombstoned" or new_rec.status == "Moved" then
        local expires = tonumber(new_rec.tombstone_expires_at_ms) or 0
        if now_ms < expires then
            return {"ERR_NEW_TOMBSTONED", tostring(expires)}
        end
    end
end

-- 3. Atomic commit
redis.call('SET', new_key, new_record_json)
redis.call('SET', old_key, moved_record_json)
if cooldown_ms > 0 then
    redis.call('PEXPIRE', old_key, cooldown_ms)
end
return {"OK", "RENAMED"}
"#;

/// Formats canonical username into Redis key.
pub fn format_username_key(normalized: &str) -> String {
    format!("{}{}", USERNAME_KEY_PREFIX, normalized)
}

/// Parses the Lua claim script output table into a [`UsernameClaimResult`] or [`UsernameError`].
pub fn parse_claim_response(res: &[String], normalized: &str) -> Result<UsernameClaimResult> {
    if res.is_empty() {
        return Err(UsernameError::RespError("Empty response from Redis script".into()).into());
    }

    match res[0].as_str() {
        "OK" => {
            if res.get(1).map(|s| s.as_str()) == Some("ALREADY_OWNED") {
                Ok(UsernameClaimResult::AlreadyOwned)
            } else {
                Ok(UsernameClaimResult::Claimed)
            }
        }
        "ERR_COLLISION" => {
            let owner_hex = res.get(1).cloned().unwrap_or_default();
            Err(UsernameError::NameCollision(normalized.to_string(), owner_hex).into())
        }
        "ERR_TOMBSTONED" => {
            let expires_at = res
                .get(1)
                .and_then(|s| s.parse::<i64>().ok())
                .unwrap_or_default();
            Err(UsernameError::Tombstoned(normalized.to_string(), expires_at).into())
        }
        other => Err(UsernameError::RespError(format!(
            "Unexpected response code from Redis claim: {}",
            other
        ))
        .into()),
    }
}

/// Parses the Lua rename script output table into `Ok(())` or [`UsernameError`].
pub fn parse_rename_response(res: &[String], old_norm: &str, new_norm: &str) -> Result<()> {
    if res.is_empty() {
        return Err(UsernameError::RespError("Empty response from Redis script".into()).into());
    }

    match res[0].as_str() {
        "OK" => Ok(()),
        "ERR_OLD_NOT_FOUND" => Err(UsernameError::InvalidFormat(format!(
            "Username '{}' does not exist",
            old_norm
        ))
        .into()),
        "ERR_OLD_COLLISION" => {
            let owner_hex = res.get(1).cloned().unwrap_or_default();
            Err(UsernameError::NameCollision(old_norm.to_string(), owner_hex).into())
        }
        "ERR_NEW_COLLISION" => {
            let owner_hex = res.get(1).cloned().unwrap_or_default();
            Err(UsernameError::NameCollision(new_norm.to_string(), owner_hex).into())
        }
        "ERR_NEW_TOMBSTONED" => {
            let expires_at = res
                .get(1)
                .and_then(|s| s.parse::<i64>().ok())
                .unwrap_or_default();
            Err(UsernameError::Tombstoned(new_norm.to_string(), expires_at).into())
        }
        other => Err(UsernameError::RespError(format!(
            "Unexpected response code from Redis rename: {}",
            other
        ))
        .into()),
    }
}

/// Clustered Redis RESP username and tombstone store.
///
/// Implements [`UsernameStore`] using atomic CAS operations over Apache Kvrocks or Redis-XC.
#[derive(Clone)]
pub struct RespUsernameStore {
    client: redis::Client,
    conn: Arc<Mutex<redis::Connection>>,
    url: String,
}

/// Alias for [`RespUsernameStore`] adhering to the clustered relay architecture naming.
pub type RespRelayStore = RespUsernameStore;

impl RespUsernameStore {
    /// Connect to a Redis RESP endpoint (e.g. `redis://127.0.0.1:6666`).
    pub fn open(url: &str) -> Result<Self> {
        let client =
            redis::Client::open(url).map_err(|e| UsernameError::RespError(e.to_string()))?;
        let conn = client
            .get_connection()
            .map_err(|e| UsernameError::RespError(e.to_string()))?;
        Ok(Self {
            client,
            conn: Arc::new(Mutex::new(conn)),
            url: url.to_string(),
        })
    }

    /// Construct from an existing [`redis::Client`].
    pub fn from_client(client: redis::Client, url: String) -> Result<Self> {
        let conn = client
            .get_connection()
            .map_err(|e| UsernameError::RespError(e.to_string()))?;
        Ok(Self {
            client,
            conn: Arc::new(Mutex::new(conn)),
            url,
        })
    }

    /// Access the Redis URL this store connects to.
    pub fn url(&self) -> &str {
        &self.url
    }

    /// Return the raw Lua claim script.
    pub fn claim_script() -> &'static str {
        LUA_CLAIM_SCRIPT
    }

    /// Return the raw Lua tombstone script.
    pub fn tombstone_script() -> &'static str {
        LUA_TOMBSTONE_SCRIPT
    }

    /// Return the raw Lua rename script.
    pub fn rename_script() -> &'static str {
        LUA_RENAME_SCRIPT
    }

    fn with_conn<F, R>(&self, f: F) -> Result<R>
    where
        F: Fn(&mut redis::Connection) -> std::result::Result<R, redis::RedisError>,
    {
        let mut guard = self
            .conn
            .lock()
            .map_err(|_| UsernameError::RespError("Connection lock poisoned".into()))?;
        match f(&mut guard) {
            Ok(res) => Ok(res),
            Err(err) => {
                // If connection dropped or broke, attempt to reconnect once
                if let Ok(mut new_conn) = self.client.get_connection() {
                    if let Ok(res) = f(&mut new_conn) {
                        *guard = new_conn;
                        return Ok(res);
                    }
                }
                Err(UsernameError::RespError(err.to_string()).into())
            }
        }
    }
}

impl std::fmt::Debug for RespUsernameStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RespUsernameStore")
            .field("url", &self.url)
            .finish()
    }
}

impl UsernameStore for RespUsernameStore {
    fn get(&self, raw_username: &str) -> Result<Option<UsernameRecord>> {
        let normalized = match DbDirectoryUsernames::validate_and_normalize(raw_username) {
            Ok(n) => n,
            Err(_) => return Ok(None),
        };

        let key = format_username_key(&normalized);
        let raw_opt: Option<String> =
            self.with_conn(|conn| redis::cmd("GET").arg(&key).query(conn))?;

        match raw_opt {
            Some(raw) => {
                let record: UsernameRecord = serde_json::from_str(&raw)
                    .map_err(|e| UsernameError::RespError(e.to_string()))?;
                Ok(Some(record))
            }
            None => Ok(None),
        }
    }

    fn claim(
        &self,
        raw_username: &str,
        account_address: &[u8; 20],
        stamp_key: Option<Vec<u8>>,
        now_ms: i64,
    ) -> Result<UsernameClaimResult> {
        let normalized = DbDirectoryUsernames::validate_and_normalize(raw_username)?;
        let key = format_username_key(&normalized);

        let new_record = UsernameRecord {
            username: normalized.clone(),
            account_address: *account_address,
            stamp_key: stamp_key.clone(),
            status: UsernameStatus::Active,
            updated_at_ms: now_ms,
            tombstone_expires_at_ms: None,
            redirect_to: None,
        };

        let updated_record = UsernameRecord {
            username: normalized.clone(),
            account_address: *account_address,
            stamp_key,
            status: UsernameStatus::Active,
            updated_at_ms: now_ms,
            tombstone_expires_at_ms: None,
            redirect_to: None,
        };

        let req_addr_json = serde_json::to_string(account_address)
            .map_err(|e| UsernameError::RespError(e.to_string()))?;
        let new_json = serde_json::to_string(&new_record)
            .map_err(|e| UsernameError::RespError(e.to_string()))?;
        let updated_json = serde_json::to_string(&updated_record)
            .map_err(|e| UsernameError::RespError(e.to_string()))?;

        let res: Vec<String> = self.with_conn(|conn| {
            let script = redis::Script::new(LUA_CLAIM_SCRIPT);
            script
                .key(&key)
                .arg(&req_addr_json)
                .arg(now_ms)
                .arg(&new_json)
                .arg(&updated_json)
                .invoke(conn)
        })?;

        parse_claim_response(&res, &normalized)
    }

    fn tombstone(
        &self,
        raw_username: &str,
        account_address: &[u8; 20],
        cooldown_duration_ms: i64,
        now_ms: i64,
    ) -> Result<bool> {
        let normalized = DbDirectoryUsernames::validate_and_normalize(raw_username)?;
        let key = format_username_key(&normalized);

        let existing = match self.get(&normalized)? {
            Some(e) => e,
            None => return Ok(false),
        };

        if existing.account_address != *account_address {
            return Ok(false);
        }

        let tombstone_record = UsernameRecord {
            username: normalized.clone(),
            account_address: *account_address,
            stamp_key: existing.stamp_key,
            status: UsernameStatus::Tombstoned,
            updated_at_ms: now_ms,
            tombstone_expires_at_ms: Some(now_ms + cooldown_duration_ms),
            redirect_to: None,
        };

        let req_addr_json = serde_json::to_string(account_address)
            .map_err(|e| UsernameError::RespError(e.to_string()))?;
        let tomb_json = serde_json::to_string(&tombstone_record)
            .map_err(|e| UsernameError::RespError(e.to_string()))?;

        let res: i64 = self.with_conn(|conn| {
            let script = redis::Script::new(LUA_TOMBSTONE_SCRIPT);
            script
                .key(&key)
                .arg(&req_addr_json)
                .arg(now_ms)
                .arg(cooldown_duration_ms)
                .arg(&tomb_json)
                .invoke(conn)
        })?;

        Ok(res == 1)
    }

    fn rename(
        &self,
        old_username: &str,
        new_username: &str,
        account_address: &[u8; 20],
        cooldown_duration_ms: i64,
        now_ms: i64,
    ) -> Result<()> {
        let old_norm = DbDirectoryUsernames::validate_and_normalize(old_username)?;
        let new_norm = DbDirectoryUsernames::validate_and_normalize(new_username)?;

        if old_norm == new_norm {
            return Ok(());
        }

        let old_key = format_username_key(&old_norm);
        let new_key = format_username_key(&new_norm);

        // Fetch existing old record for stamp_key transfer
        let existing_old = match self.get(&old_norm)? {
            Some(r) => r,
            None => {
                return Err(UsernameError::InvalidFormat(format!(
                    "Username '{}' does not exist",
                    old_norm
                ))
                .into());
            }
        };

        if existing_old.account_address != *account_address {
            let current_hex = hex::encode(existing_old.account_address);
            return Err(UsernameError::NameCollision(old_norm, current_hex).into());
        }

        let new_record = UsernameRecord {
            username: new_norm.clone(),
            account_address: *account_address,
            stamp_key: existing_old.stamp_key.clone(),
            status: UsernameStatus::Active,
            updated_at_ms: now_ms,
            tombstone_expires_at_ms: None,
            redirect_to: None,
        };

        let moved_record = UsernameRecord {
            username: old_norm.clone(),
            account_address: *account_address,
            stamp_key: existing_old.stamp_key,
            status: UsernameStatus::Moved,
            updated_at_ms: now_ms,
            tombstone_expires_at_ms: Some(now_ms + cooldown_duration_ms),
            redirect_to: Some(new_norm.clone()),
        };

        let req_addr_json = serde_json::to_string(account_address)
            .map_err(|e| UsernameError::RespError(e.to_string()))?;
        let new_json = serde_json::to_string(&new_record)
            .map_err(|e| UsernameError::RespError(e.to_string()))?;
        let moved_json = serde_json::to_string(&moved_record)
            .map_err(|e| UsernameError::RespError(e.to_string()))?;

        let res: Vec<String> = self.with_conn(|conn| {
            let script = redis::Script::new(LUA_RENAME_SCRIPT);
            script
                .key(&old_key)
                .key(&new_key)
                .arg(&req_addr_json)
                .arg(now_ms)
                .arg(cooldown_duration_ms)
                .arg(&new_json)
                .arg(&moved_json)
                .invoke(conn)
        })?;

        parse_rename_response(&res, &old_norm, &new_norm)
    }
}

#[cfg(test)]
mod tests {
    use bitcoinsuite_error::Result;

    use super::*;

    #[test]
    fn test_resp_key_formatting() {
        assert_eq!(format_username_key("alice"), "username:alice");
        assert_eq!(format_username_key("bob_123"), "username:bob_123");
        assert_eq!(format_username_key("charlie-dev"), "username:charlie-dev");
    }

    #[test]
    fn test_record_serialization_roundtrip() -> Result<()> {
        let addr = [7u8; 20];
        let record = UsernameRecord {
            username: "alice".to_string(),
            account_address: addr,
            stamp_key: Some(vec![1, 2, 3, 4]),
            status: UsernameStatus::Active,
            updated_at_ms: 1700000000,
            tombstone_expires_at_ms: None,
            redirect_to: None,
        };

        let json = serde_json::to_string(&record).unwrap();
        let decoded: UsernameRecord = serde_json::from_str(&json).unwrap();
        assert_eq!(record, decoded);

        // Tombstoned record
        let tombstone = UsernameRecord {
            username: "bob".to_string(),
            account_address: [8u8; 20],
            stamp_key: None,
            status: UsernameStatus::Tombstoned,
            updated_at_ms: 1700000100,
            tombstone_expires_at_ms: Some(1700000100 + 60000),
            redirect_to: None,
        };
        let tomb_json = serde_json::to_string(&tombstone).unwrap();
        let tomb_decoded: UsernameRecord = serde_json::from_str(&tomb_json).unwrap();
        assert_eq!(tombstone, tomb_decoded);

        // Moved record
        let moved = UsernameRecord {
            username: "bob_old".to_string(),
            account_address: [8u8; 20],
            stamp_key: None,
            status: UsernameStatus::Moved,
            updated_at_ms: 1700000200,
            tombstone_expires_at_ms: Some(1700000200 + 60000),
            redirect_to: Some("bob_new".to_string()),
        };
        let moved_json = serde_json::to_string(&moved).unwrap();
        let moved_decoded: UsernameRecord = serde_json::from_str(&moved_json).unwrap();
        assert_eq!(moved, moved_decoded);

        Ok(())
    }

    #[test]
    fn test_claim_script_and_response_parsing() {
        assert!(LUA_CLAIM_SCRIPT.contains("cjson.decode"));
        assert!(LUA_CLAIM_SCRIPT.contains("redis.call('GET', key)"));
        assert!(LUA_CLAIM_SCRIPT.contains("redis.call('SET', key, new_json)"));

        // OK, CLAIMED
        let res_claimed = vec!["OK".to_string(), "CLAIMED".to_string()];
        let parsed = parse_claim_response(&res_claimed, "alice").unwrap();
        assert_eq!(parsed, UsernameClaimResult::Claimed);

        // OK, ALREADY_OWNED
        let res_owned = vec!["OK".to_string(), "ALREADY_OWNED".to_string()];
        let parsed_owned = parse_claim_response(&res_owned, "alice").unwrap();
        assert_eq!(parsed_owned, UsernameClaimResult::AlreadyOwned);

        // ERR_COLLISION
        let res_coll = vec![
            "ERR_COLLISION".to_string(),
            "0102030405060708090a0b0c0d0e0f1011121314".to_string(),
        ];
        let err_coll = parse_claim_response(&res_coll, "alice").unwrap_err();
        assert!(err_coll.to_string().contains("already registered"));

        // ERR_TOMBSTONED
        let res_tomb = vec!["ERR_TOMBSTONED".to_string(), "1700060000".to_string()];
        let err_tomb = parse_claim_response(&res_tomb, "alice").unwrap_err();
        assert!(err_tomb.to_string().contains("tombstoned until 1700060000"));
    }

    #[test]
    fn test_rename_script_and_response_parsing() {
        assert!(LUA_RENAME_SCRIPT.contains("redis.call('GET', old_key)"));
        assert!(LUA_RENAME_SCRIPT.contains("redis.call('GET', new_key)"));
        assert!(LUA_RENAME_SCRIPT.contains("redis.call('SET', new_key, new_record_json)"));
        assert!(LUA_RENAME_SCRIPT.contains("redis.call('SET', old_key, moved_record_json)"));
        assert!(LUA_RENAME_SCRIPT.contains("PEXPIRE"));

        // OK, RENAMED
        let res_ok = vec!["OK".to_string(), "RENAMED".to_string()];
        assert!(parse_rename_response(&res_ok, "alice", "alice_new").is_ok());

        // ERR_OLD_NOT_FOUND
        let res_not_found = vec!["ERR_OLD_NOT_FOUND".to_string(), "".to_string()];
        let err = parse_rename_response(&res_not_found, "alice", "alice_new").unwrap_err();
        assert!(err.to_string().contains("does not exist"));

        // ERR_OLD_COLLISION
        let res_old_coll = vec!["ERR_OLD_COLLISION".to_string(), "abcd".to_string()];
        let err = parse_rename_response(&res_old_coll, "alice", "alice_new").unwrap_err();
        assert!(err.to_string().contains("already registered"));

        // ERR_NEW_COLLISION
        let res_new_coll = vec!["ERR_NEW_COLLISION".to_string(), "ef01".to_string()];
        let err = parse_rename_response(&res_new_coll, "alice", "alice_new").unwrap_err();
        assert!(err.to_string().contains("already registered"));

        // ERR_NEW_TOMBSTONED
        let res_new_tomb = vec!["ERR_NEW_TOMBSTONED".to_string(), "1700099999".to_string()];
        let err = parse_rename_response(&res_new_tomb, "alice", "alice_new").unwrap_err();
        assert!(err.to_string().contains("tombstoned until 1700099999"));
    }

    #[test]
    fn test_tombstone_script_generation() {
        assert!(LUA_TOMBSTONE_SCRIPT.contains("redis.call('GET', key)"));
        assert!(LUA_TOMBSTONE_SCRIPT.contains("redis.call('SET', key, tombstone_json)"));
        assert!(LUA_TOMBSTONE_SCRIPT.contains("PEXPIRE"));
    }
}

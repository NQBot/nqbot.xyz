#!/usr/bin/env python3
"""Fail closed on unsafe public snapshots, downloads, and site configuration."""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import math
import re
import stat
import zipfile
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import unquote, urlsplit

from generate_checksums import MANIFEST_NAME, downloadable_artifacts, render_manifest


PUBLIC_SCHEMA_VERSION = 2
MAX_PUBLIC_SNAPSHOT_BYTES = 500_000
MAX_PUBLIC_STRING_CHARS = 2_048
MAX_SERIES_POINTS = 300
MAX_ARRAY_ITEMS = 2_000
MAX_ARCHIVE_ENTRY_BYTES = 5_000_000
MAX_ARCHIVE_EXPANDED_BYTES = 25_000_000
MAX_ARCHIVE_FILE_BYTES = 10_000_000
MAX_COMPRESSION_RATIO = 200

LEAF = object()

SUMMARY_KEYS = (
    "total_algos",
    "active_algos",
    "open_trades",
    "trades_today",
    "net_pnl",
    "net_pnl_pts",
    "wins",
    "losses",
    "win_rate",
    "peak_equity",
    "current_drawdown",
    "max_drawdown",
    "max_drawdown_time",
)
STATE_ACCOUNT_KEYS = (
    "id",
    "name",
    "session",
    "session_active",
    "in_trade",
    "direction",
    "pnl",
    "net_liquidation",
    "balance",
    "tier",
    "trade_count",
    "is_bot",
    "status",
    "display_status",
    "display_color",
)
DAILY_ACCOUNT_KEYS = (
    "id",
    "name",
    "session",
    "tier",
    "is_bot",
    "session_active",
    "in_trade",
    "direction",
    "trade_count",
    "current_net_liquidation",
    "daily_pnl",
    "daily_realized_pnl",
    "unrealized_pnl",
    "stale",
)
DAILY_SUMMARY_KEYS = (
    "account_count",
    "stale_account_count",
    "total_daily_pnl",
    "total_daily_realized_pnl",
    "positive_accounts",
    "negative_accounts",
    "flat_accounts",
)
QUALITY_KEYS = (
    "exact_ati_fill_gross",
    "nt8_realized_pnl",
    "market_snapshot_inferred",
)
HISTORY_TRADE_KEYS = (
    "entry_ts",
    "exit_ts",
    "direction",
    "quantity",
    "entry_price",
    "exit_price",
    "exit_reason",
    "outcome",
    "pnl_points",
    "pnl_dollars",
    "gross_pnl_dollars",
    "r_multiple",
    "source_quality",
    "commission_included",
)
HISTORY_ACCOUNT_KEYS = (
    "id",
    "name",
    "session",
    "trade_count",
    "gross_pnl",
    "net_pnl",
    "pnl",
    "winning_trades",
    "losing_trades",
    "flat_trades",
)
HISTORY_DAY_KEYS = (
    "trading_day",
    "kind",
    "trade_count",
    "account_count",
    "total_pnl",
    "total_gross_pnl",
    "positive_accounts",
    "negative_accounts",
    "flat_accounts",
)
ARENA_ROW_KEYS = (
    "account",
    "strategy",
    "status",
    "display_status",
    "display_color",
    "attempt",
    "shadow_balance",
    "to_target",
    "official_passes",
    "official_fails",
)


def _schema(keys: tuple[str, ...]) -> dict[str, Any]:
    return {key: LEAF for key in keys}


QUALITY_SCHEMA = _schema(QUALITY_KEYS)
DAILY_ACCOUNT_SUMMARY_SCHEMA = _schema(
    (
        "id",
        "name",
        "session",
        "tier",
        "is_bot",
        "daily_pnl",
        "daily_realized_pnl",
        "current_net_liquidation",
        "trade_count",
        "in_trade",
        "direction",
    )
)
HISTORY_SUMMARY_ACCOUNT_SCHEMA = {
    **_schema(("id", "name", "trade_count", "pnl", "gross_pnl")),
    "quality_counts": QUALITY_SCHEMA,
}
HISTORY_TRADE_SCHEMA = _schema(HISTORY_TRADE_KEYS)
HISTORY_ACCOUNT_SCHEMA = {
    **_schema(HISTORY_ACCOUNT_KEYS),
    "quality_counts": QUALITY_SCHEMA,
    "trades": [HISTORY_TRADE_SCHEMA],
}
HISTORY_DAY_SCHEMA = {
    **_schema(HISTORY_DAY_KEYS),
    "best_account": HISTORY_SUMMARY_ACCOUNT_SCHEMA,
    "worst_account": HISTORY_SUMMARY_ACCOUNT_SCHEMA,
    "quality_counts": QUALITY_SCHEMA,
    "accounts": [HISTORY_ACCOUNT_SCHEMA],
}
PUBLIC_SCHEMAS: dict[str, dict[str, Any]] = {
    "scoreboard_snapshot.json": {
        "schema_version": LEAF,
        "timestamp": LEAF,
        "session": LEAF,
        "price": LEAF,
        "summary": _schema(SUMMARY_KEYS),
        "active_trades": [
            _schema(("name", "direction", "entry_price", "unrealized_pnl", "duration"))
        ],
        "recent_exits": [
            _schema(("name", "direction", "entry_price", "pnl_pts", "duration", "reason"))
        ],
    },
    "scoreboard_state_snapshot.json": {
        "schema_version": LEAF,
        "timestamp": LEAF,
        "trading_day": LEAF,
        "tracking_since": LEAF,
        "session": LEAF,
        "algos": [_schema(STATE_ACCOUNT_KEYS)],
    },
    "account_daily_pnl_snapshot.json": {
        "schema_version": LEAF,
        "timestamp": LEAF,
        "generated_at": LEAF,
        "trading_day": LEAF,
        "sample_interval_sec": LEAF,
        "accounts": [
            {**_schema(DAILY_ACCOUNT_KEYS), "series": [{"ts": LEAF, "daily_pnl": LEAF}]}
        ],
        "summary": {
            **_schema(DAILY_SUMMARY_KEYS),
            "best_account": DAILY_ACCOUNT_SUMMARY_SCHEMA,
            "worst_account": DAILY_ACCOUNT_SUMMARY_SCHEMA,
        },
    },
    "account_pnl_history_snapshot.json": {
        "schema_version": LEAF,
        "generated_at": LEAF,
        "timezone": LEAF,
        "reset_time_et": LEAF,
        "instrument": LEAF,
        "point_value": LEAF,
        "history": {"algos": [HISTORY_DAY_SCHEMA], "bots": [HISTORY_DAY_SCHEMA]},
    },
    "eval_arena_snapshot.json": {
        "schema_version": LEAF,
        "updated": LEAF,
        "account_size": LEAF,
        "win_level": LEAF,
        "rows": [_schema(ARENA_ROW_KEYS)],
    },
}
REQUIRED_ROOT_KEYS = {
    "scoreboard_snapshot.json": {
        "schema_version",
        "timestamp",
        "summary",
        "active_trades",
        "recent_exits",
    },
    "scoreboard_state_snapshot.json": {
        "schema_version",
        "timestamp",
        "session",
        "algos",
    },
    "account_daily_pnl_snapshot.json": {
        "schema_version",
        "trading_day",
        "accounts",
        "summary",
    },
    "account_pnl_history_snapshot.json": {
        "schema_version",
        "generated_at",
        "history",
    },
    "eval_arena_snapshot.json": {"schema_version", "updated", "rows"},
}

FORBIDDEN_EXACT_KEYS = {
    "chart_url",
    "endpoint",
    "entry_price_source",
    "file",
    "filename",
    "fill_price",
    "path",
    "pnl_source_hash",
    "private_endpoint",
    "requested_entry",
    "signal_id",
    "source_files",
    "source_hash",
    "source_path",
    "stop",
    "stop_price",
    "target",
    "target_price",
    "trade_id",
    "url",
}
SECRET_KEY_RE = re.compile(
    r"(?:^|_)(?:access_key|api_?key|authorization|auth|client_secret|credential|"
    r"password|passwd|private_key|refresh_token|secret|session_key|token|"
    r"webhook_secret)(?:_|$)",
    re.IGNORECASE,
)
ABSOLUTE_PATH_RE = re.compile(r"^(?:[A-Za-z]:[\\/]|\\\\|//|/)")
EMBEDDED_WINDOWS_PATH_RE = re.compile(r"(?:^|[\s\"'(=])(?:[A-Za-z]:[\\/]|\\\\)")
EMBEDDED_POSIX_PATH_RE = re.compile(
    r"(?:^|[\s\"'(=])/(?:Users|etc|home|mnt|opt|private|root|run|srv|tmp|usr|var)(?:/|$)"
)
URL_RE = re.compile(r"\b(?:https?|wss?)://[^\s<>\"']+", re.IGNORECASE)
IP_RE = re.compile(r"(?<![0-9A-Fa-f:.])(?:\d{1,3}\.){3}\d{1,3}(?![0-9A-Fa-f:.])")
BARE_PRIVATE_HOST_RE = re.compile(
    r"(?i)(?:^|[^A-Za-z0-9.-])(?:localhost|[A-Za-z0-9.-]+\."
    r"(?:internal|lan|local))(?::\d+)?(?:$|[/\s])"
)
SECRET_VALUE_PATTERNS = (
    ("private key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("bearer credential", re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{12,}", re.IGNORECASE)),
    ("GitHub token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b")),
    ("GitHub token", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b")),
    ("Slack token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    ("AWS access key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("Google API key", re.compile(r"\bAIza[0-9A-Za-z_-]{25,}\b")),
    ("Facebook token", re.compile(r"\bEAA[A-Za-z0-9]{30,}\b")),
    (
        "JSON web token",
        re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"),
    ),
    (
        "credential-bearing URL",
        re.compile(r"\bhttps?://[^\s/:@]+:[^\s/@]+@", re.IGNORECASE),
    ),
)
FORBIDDEN_PUBLIC_PATHS = {
    ".claude.json",
    ".mcp.json",
    "config/mcp-servers-template.json",
    "mcp.json",
}
SENSITIVE_FILENAMES = {".env", "id_dsa", "id_ed25519", "id_rsa"}
SENSITIVE_SUFFIXES = {".key", ".p12", ".pem", ".pfx"}
TEXT_SUFFIXES = {".css", ".html", ".js", ".json", ".md", ".txt", ".xml", ".yaml", ".yml"}
ARCHIVE_TEXT_SUFFIXES = {".cs", ".json", ".md", ".txt", ".xml"}
ARCHIVE_ALLOWED_SUFFIXES = ARCHIVE_TEXT_SUFFIXES


class DuplicateKeyError(ValueError):
    pass


def _no_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateKeyError(f"duplicate JSON key {key!r}")
        result[key] = value
    return result


def _reject_constant(value: str) -> None:
    raise ValueError(f"non-finite JSON number {value}")


def _validate_shape(value: Any, schema: Any, path: str, errors: list[str]) -> None:
    if schema is LEAF:
        if not isinstance(value, (str, int, float, bool, type(None))):
            errors.append(f"{path}: expected a JSON scalar")
        elif isinstance(value, float) and not math.isfinite(value):
            errors.append(f"{path}: non-finite number")
        return

    if isinstance(schema, dict):
        if value is None:
            return
        if not isinstance(value, dict):
            errors.append(f"{path}: expected an object")
            return
        unknown = sorted(set(value) - set(schema))
        if unknown:
            errors.append(f"{path}: unknown key {unknown[0]!r}")
        for key in sorted(set(value) & set(schema)):
            _validate_shape(value[key], schema[key], f"{path}.{key}", errors)
        return

    if isinstance(schema, list) and len(schema) == 1:
        if not isinstance(value, list):
            errors.append(f"{path}: expected an array")
            return
        limit = MAX_SERIES_POINTS if path.endswith(".series") else MAX_ARRAY_ITEMS
        if len(value) > limit:
            errors.append(f"{path}: contains {len(value)} items; limit is {limit}")
            return
        for index, child in enumerate(value):
            _validate_shape(child, schema[0], f"{path}[{index}]", errors)
        return

    raise RuntimeError(f"invalid schema definition at {path}")


def _private_host(host: str | None) -> bool:
    if not host:
        return False
    normalized = host.rstrip(".").lower()
    if normalized == "localhost" or normalized.endswith(
        (".localhost", ".local", ".internal", ".lan")
    ):
        return True
    try:
        address = ipaddress.ip_address(normalized)
    except ValueError:
        return False
    return bool(
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_reserved
        or address.is_unspecified
    )


def _secret_finding(value: str) -> str | None:
    for label, pattern in SECRET_VALUE_PATTERNS:
        if pattern.search(value):
            return label
    return None


def _validate_string(value: str, path: str, errors: list[str]) -> None:
    if len(value) > MAX_PUBLIC_STRING_CHARS:
        errors.append(f"{path}: string exceeds {MAX_PUBLIC_STRING_CHARS} characters")
    if (
        ABSOLUTE_PATH_RE.match(value.strip())
        or EMBEDDED_WINDOWS_PATH_RE.search(value)
        or EMBEDDED_POSIX_PATH_RE.search(value)
        or value.strip().lower().startswith("file://")
    ):
        errors.append(f"{path}: absolute filesystem path is not public data")
    for match in URL_RE.finditer(value):
        if _private_host(urlsplit(match.group(0)).hostname):
            errors.append(f"{path}: private or loopback endpoint is not public data")
            break
    for candidate in IP_RE.findall(value):
        if _private_host(candidate):
            errors.append(f"{path}: private or loopback address is not public data")
            break
    if BARE_PRIVATE_HOST_RE.search(value) or re.search(
        r"(?i)(?:^|[\s\[])::1(?:$|[\]\s:/])", value
    ):
        errors.append(f"{path}: private or loopback host is not public data")
    finding = _secret_finding(value)
    if finding:
        errors.append(f"{path}: contains {finding}")


def _validate_safe_values(value: Any, path: str, errors: list[str]) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            normalized = str(key).strip().lower()
            if normalized in FORBIDDEN_EXACT_KEYS or SECRET_KEY_RE.search(normalized):
                errors.append(f"{path}: forbidden key {key!r}")
            _validate_safe_values(child, f"{path}.{key}", errors)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _validate_safe_values(child, f"{path}[{index}]", errors)
    elif isinstance(value, str):
        _validate_string(value, path, errors)


def validate_json_snapshots(root: Path) -> list[str]:
    errors: list[str] = []
    for filename, schema in PUBLIC_SCHEMAS.items():
        path = root / filename
        if not path.is_file():
            errors.append(f"{filename}: required public snapshot is missing")
            continue
        size = path.stat().st_size
        if size == 0:
            errors.append(f"{filename}: empty public snapshot")
            continue
        if size > MAX_PUBLIC_SNAPSHOT_BYTES:
            errors.append(
                f"{filename}: {size} bytes exceeds the {MAX_PUBLIC_SNAPSHOT_BYTES}-byte limit"
            )
            continue
        try:
            raw = path.read_text(encoding="utf-8")
            payload = json.loads(
                raw,
                object_pairs_hook=_no_duplicate_keys,
                parse_constant=_reject_constant,
            )
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
            errors.append(f"{filename}: invalid strict JSON ({exc})")
            continue
        if not isinstance(payload, dict):
            errors.append(f"{filename}: root must be an object")
            continue
        missing = sorted(REQUIRED_ROOT_KEYS[filename] - set(payload))
        if missing:
            errors.append(f"{filename}: missing required key {missing[0]!r}")
        if payload.get("schema_version") != PUBLIC_SCHEMA_VERSION:
            errors.append(
                f"{filename}: schema_version must be {PUBLIC_SCHEMA_VERSION}"
            )
            # A legacy payload can have hundreds of now-private fields. The
            # version failure is sufficient and keeps CI output bounded; full
            # shape/value validation applies once the producer emits v2.
            continue
        _validate_shape(payload, schema, filename, errors)
        _validate_safe_values(payload, filename, errors)
    return errors


class _SiteLinkParser(HTMLParser):
    def __init__(self, source: str) -> None:
        super().__init__(convert_charrefs=True)
        self.source = source
        self.zip_links: list[tuple[int, str]] = []
        self.blank_links_without_noopener: list[int] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "a":
            return
        attributes = {name.lower(): (value or "") for name, value in attrs}
        line = self.getpos()[0]
        if attributes.get("target", "").lower() == "_blank":
            rel = {value.lower() for value in attributes.get("rel", "").split()}
            if "noopener" not in rel:
                self.blank_links_without_noopener.append(line)
        href = attributes.get("href", "")
        if urlsplit(href).path.lower().endswith(".zip"):
            self.zip_links.append((line, href))


def validate_html(root: Path, manifest_paths: set[str]) -> list[str]:
    errors: list[str] = []
    for path in sorted(root.rglob("*.html")):
        if ".git" in path.parts:
            continue
        relative = path.relative_to(root).as_posix()
        try:
            content = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as exc:
            errors.append(f"{relative}: unreadable HTML ({exc})")
            continue
        parser = _SiteLinkParser(relative)
        parser.feed(content)
        for line in parser.blank_links_without_noopener:
            errors.append(f"{relative}:{line}: target=_blank link is missing rel=noopener")
        for line, href in parser.zip_links:
            parsed = urlsplit(href)
            if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment:
                errors.append(f"{relative}:{line}: download link must be a plain local path")
                continue
            decoded = unquote(parsed.path).replace("\\", "/")
            candidate = PurePosixPath(decoded)
            if candidate.is_absolute() or ".." in candidate.parts:
                errors.append(f"{relative}:{line}: unsafe download path")
                continue
            normalized = candidate.as_posix().lstrip("./")
            if normalized not in manifest_paths:
                errors.append(f"{relative}:{line}: download is missing from {MANIFEST_NAME}")
    return errors


def _parse_manifest(root: Path) -> tuple[dict[str, str], list[str]]:
    errors: list[str] = []
    path = root / MANIFEST_NAME
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        return {}, [f"{MANIFEST_NAME}: missing or unreadable ({exc})"]
    if "\r" in text:
        errors.append(f"{MANIFEST_NAME}: must use LF line endings")
    entries: dict[str, str] = {}
    previous = ""
    for line_number, line in enumerate(text.splitlines(), 1):
        match = re.fullmatch(r"([0-9a-f]{64})  (indicators/[A-Za-z0-9_.-]+\.zip)", line)
        if not match:
            errors.append(f"{MANIFEST_NAME}:{line_number}: invalid manifest line")
            continue
        digest, relative = match.groups()
        if relative in entries:
            errors.append(f"{MANIFEST_NAME}:{line_number}: duplicate artifact path")
        if previous and relative <= previous:
            errors.append(f"{MANIFEST_NAME}:{line_number}: paths are not sorted")
        entries[relative] = digest
        previous = relative
    return entries, errors


def _validate_archive(path: Path, root: Path) -> list[str]:
    relative = path.relative_to(root).as_posix()
    errors: list[str] = []
    expanded = 0
    try:
        with zipfile.ZipFile(path) as archive:
            infos = archive.infolist()
            expanded = sum(info.file_size for info in infos if not info.is_dir())
            if expanded > MAX_ARCHIVE_EXPANDED_BYTES:
                return [f"{relative}: expanded ZIP exceeds total-size limit"]
            for info in infos:
                if info.is_dir():
                    continue
                if info.file_size > MAX_ARCHIVE_ENTRY_BYTES:
                    errors.append(f"{relative}: ZIP member exceeds expanded-size limit")
                if info.file_size and not info.compress_size:
                    errors.append(f"{relative}: ZIP member has an invalid compression size")
                elif (
                    info.file_size >= 100_000
                    and info.file_size / max(info.compress_size, 1) > MAX_COMPRESSION_RATIO
                ):
                    errors.append(f"{relative}: ZIP member exceeds compression-ratio limit")
            if errors:
                return errors
            bad_member = archive.testzip()
            if bad_member is not None:
                errors.append(f"{relative}: corrupt ZIP member")
            for info in infos:
                name = info.filename
                normalized = name.replace("\\", "/")
                member = PurePosixPath(normalized)
                if (
                    normalized != name
                    or member.is_absolute()
                    or ".." in member.parts
                    or re.match(r"^[A-Za-z]:", normalized)
                    or "\x00" in normalized
                ):
                    errors.append(f"{relative}: unsafe ZIP member path")
                    continue
                mode = (info.external_attr >> 16) & 0o170000
                if stat.S_ISLNK(mode):
                    errors.append(f"{relative}: symbolic-link ZIP member is not allowed")
                if info.flag_bits & 0x1:
                    errors.append(f"{relative}: encrypted ZIP member is not allowed")
                if info.is_dir():
                    continue
                suffix = member.suffix.lower()
                if suffix not in ARCHIVE_ALLOWED_SUFFIXES and member.name not in {
                    "LICENSE",
                    "README",
                }:
                    errors.append(f"{relative}: ZIP contains disallowed file type {suffix or '(none)'}")
                    continue
                if suffix in ARCHIVE_TEXT_SUFFIXES or member.name in {"LICENSE", "README"}:
                    try:
                        content = archive.read(info).decode("utf-8")
                    except UnicodeDecodeError:
                        errors.append(f"{relative}: text ZIP member is not UTF-8")
                        continue
                    finding = _secret_finding(content)
                    if finding:
                        errors.append(f"{relative}: ZIP member contains {finding}")
    except (OSError, zipfile.BadZipFile, RuntimeError) as exc:
        errors.append(f"{relative}: invalid ZIP archive ({exc})")
    return errors


def validate_downloads(root: Path) -> tuple[set[str], list[str]]:
    entries, errors = _parse_manifest(root)
    artifacts = downloadable_artifacts(root)
    expected_paths = {path.relative_to(root).as_posix() for path in artifacts}
    manifest_paths = set(entries)
    missing = sorted(expected_paths - manifest_paths)
    extra = sorted(manifest_paths - expected_paths)
    if missing:
        errors.append(f"{MANIFEST_NAME}: missing artifact {missing[0]}")
    if extra:
        errors.append(f"{MANIFEST_NAME}: references missing artifact {extra[0]}")
    try:
        if (root / MANIFEST_NAME).read_text(encoding="utf-8") != render_manifest(root):
            errors.append(f"{MANIFEST_NAME}: content does not match current downloads")
    except (OSError, UnicodeError):
        pass
    for path in artifacts:
        relative = path.relative_to(root).as_posix()
        if path.is_symlink():
            errors.append(f"{relative}: download artifact cannot be a symbolic link")
            continue
        if path.stat().st_size > MAX_ARCHIVE_FILE_BYTES:
            errors.append(f"{relative}: compressed ZIP exceeds file-size limit")
            continue
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if entries.get(relative) != digest:
            errors.append(f"{relative}: SHA-256 digest does not match {MANIFEST_NAME}")
        errors.extend(_validate_archive(path, root))
    return manifest_paths, errors


def _iter_public_files(root: Path):
    for path in sorted(root.rglob("*")):
        if ".git" in path.parts:
            continue
        if path.is_symlink():
            yield path
            continue
        if not path.is_file():
            continue
        yield path


def validate_public_files(root: Path) -> list[str]:
    errors: list[str] = []
    for path in _iter_public_files(root):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink():
            errors.append(f"{relative}: symbolic links are not allowed in the public site")
            continue
        lower_name = path.name.lower()
        if relative in FORBIDDEN_PUBLIC_PATHS:
            errors.append(f"{relative}: operational configuration must not be public")
        if lower_name in SENSITIVE_FILENAMES or path.suffix.lower() in SENSITIVE_SUFFIXES:
            errors.append(f"{relative}: sensitive filename is not allowed in the public site")
        if path.suffix.lower() not in TEXT_SUFFIXES and path.name not in {
            "CNAME",
            "LICENSE",
            MANIFEST_NAME,
        }:
            continue
        try:
            content = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            continue
        finding = _secret_finding(content)
        if finding:
            errors.append(f"{relative}: contains {finding}")
    return errors


def validate_site(root: Path) -> list[str]:
    root = root.resolve()
    errors = validate_json_snapshots(root)
    manifest_paths, download_errors = validate_downloads(root)
    errors.extend(download_errors)
    errors.extend(validate_html(root, manifest_paths))
    errors.extend(validate_public_files(root))
    return sorted(set(errors))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="site repository root",
    )
    args = parser.parse_args()
    root = args.root.resolve()
    errors = validate_site(root)
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        print(f"Public-site validation failed with {len(errors)} finding(s)")
        return 1
    print(
        f"Validated {len(PUBLIC_SCHEMAS)} public snapshots and "
        f"{len(downloadable_artifacts(root))} download artifacts"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

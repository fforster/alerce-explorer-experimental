"""Tests for the session-replay analytics sink (services/analytics.py) and its
POST /api/ux_events endpoint. All offline — nothing leaves the process.
"""
from __future__ import annotations

import gzip
import json

import pytest
from fastapi.testclient import TestClient

from src.app import app
from src.services import analytics


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def enabled(monkeypatch, tmp_path):
    """Turn collection on and point the log dir at a tmp path."""
    monkeypatch.setenv("ANALYTICS_ENABLED", "1")
    monkeypatch.setenv("ANALYTICS_LOG_DIR", str(tmp_path))
    monkeypatch.setenv("ANALYTICS_IP_SALT", "test-salt")
    return tmp_path


def _read_lines(log_dir):
    """Decompress every .jsonl.gz under log_dir into parsed records."""
    records = []
    for path in sorted(log_dir.glob("*.jsonl.gz")):
        with gzip.open(path, "rt", encoding="utf-8") as fh:
            records.extend(json.loads(line) for line in fh if line.strip())
    return records


# --- is_enabled -------------------------------------------------------------

def test_is_enabled_default_off(monkeypatch):
    monkeypatch.delenv("ANALYTICS_ENABLED", raising=False)
    assert analytics.is_enabled() is False


@pytest.mark.parametrize("val", ["1", "true", "TRUE", "yes", "on"])
def test_is_enabled_truthy(monkeypatch, val):
    monkeypatch.setenv("ANALYTICS_ENABLED", val)
    assert analytics.is_enabled() is True


@pytest.mark.parametrize("val", ["0", "false", "no", "", "off"])
def test_is_enabled_falsy(monkeypatch, val):
    monkeypatch.setenv("ANALYTICS_ENABLED", val)
    assert analytics.is_enabled() is False


# --- append -----------------------------------------------------------------

def test_append_round_trip_and_hashed_ip(enabled):
    payload = {"session_id": "s1", "visitor_id": "v1",
               "identity": {"auth": "anonymous", "data_rights_tier": "public"},
               "events": [{"type": 2}, {"type": 3}]}
    analytics.append(payload, client_ip="203.0.113.7")

    records = _read_lines(enabled)
    assert len(records) == 1
    rec = records[0]
    # Provenance wrapper, client payload preserved verbatim.
    assert rec["payload"] == payload
    assert isinstance(rec["server_ts"], (int, float))
    # IP is hashed, never stored raw.
    assert rec["ip_hash"] and rec["ip_hash"] != "203.0.113.7"
    assert "203.0.113.7" not in json.dumps(rec)


def test_append_no_ip_gives_null_hash(enabled):
    analytics.append({"events": []}, client_ip=None)
    assert _read_lines(enabled)[0]["ip_hash"] is None


def test_append_multiple_batches_concatenate(enabled):
    analytics.append({"events": [1]}, client_ip="10.0.0.1")
    analytics.append({"events": [2]}, client_ip="10.0.0.2")
    records = _read_lines(enabled)
    assert [r["payload"]["events"] for r in records] == [[1], [2]]
    # Same client IP → same hash; different IP → different hash.
    assert records[0]["ip_hash"] != records[1]["ip_hash"]


# --- POST /api/ux_events ----------------------------------------------------

def test_post_writes_when_enabled(client, enabled):
    body = {"session_id": "s", "events": [{"type": 2}]}
    resp = client.post("/api/ux_events", json=body)
    assert resp.status_code == 204
    records = _read_lines(enabled)
    assert len(records) == 1
    assert records[0]["payload"]["session_id"] == "s"


def test_post_noop_when_disabled(client, monkeypatch, tmp_path):
    monkeypatch.delenv("ANALYTICS_ENABLED", raising=False)
    monkeypatch.setenv("ANALYTICS_LOG_DIR", str(tmp_path))
    resp = client.post("/api/ux_events", json={"events": []})
    assert resp.status_code == 204
    assert list(tmp_path.glob("*.jsonl.gz")) == []


def test_post_garbage_body_is_204_and_no_write(client, enabled):
    resp = client.post("/api/ux_events", content=b"\x00not json",
                       headers={"Content-Type": "application/json"})
    assert resp.status_code == 204
    assert _read_lines(enabled) == []


# --- template gating --------------------------------------------------------

def test_index_omits_scripts_when_disabled(client, monkeypatch):
    monkeypatch.delenv("ANALYTICS_ENABLED", raising=False)
    body = client.get("/").text
    assert "recorder.min.js" not in body
    assert "/static/js/ux_recorder.js" not in body


def test_index_includes_scripts_when_enabled(client, monkeypatch):
    monkeypatch.setenv("ANALYTICS_ENABLED", "1")
    body = client.get("/").text
    assert "recorder.min.js" in body
    assert "/static/js/ux_recorder.js" in body

"""Classifier dropdown building.

The ALeRCE API returns one row per (classifier_name, classifier_version);
for the UI we want one entry per classifier_name with its class list. Priority
ordering matches the prototype so the "top" classifier lands first.
"""
from __future__ import annotations

from typing import Any

from . import alerce_client

# Lower = earlier in the dropdown. Unknown classifiers fall back to 999.
_PRIORITY: dict[str, dict[str, int]] = {
    "lsst": {
        "lc_classifier_top": 0,
        "lc_classifier_transient": 1,
        "lc_classifier_stochastic": 2,
        "lc_classifier_periodic": 3,
    },
    "ztf": {
        "lc_classifier": 0,
        "lc_classifier_top": 1,
        "lc_classifier_transient": 2,
        "lc_classifier_stochastic": 3,
        "lc_classifier_periodic": 4,
        "stamp_classifier": 5,
    },
}


def _format_name(raw: str) -> str:
    return raw.replace("_", " ").replace(" classifier", " classifier")


def tidy_classifiers(raw: Any, survey: str) -> list[dict[str, Any]]:
    """Dedupe by classifier_name, collect classes, sort by priority."""
    rows = raw if isinstance(raw, list) else raw.get("classifiers", [])
    priorities = _PRIORITY.get(survey, {})

    by_name: dict[str, dict[str, Any]] = {}
    for row in rows:
        name = row.get("classifier_name")
        if not name:
            continue
        classes = row.get("classes") or []
        entry = by_name.setdefault(
            name,
            {
                "classifier_name": name,
                "formatted_name": _format_name(name),
                "classes": [],
            },
        )
        # Merge class lists across versions, preserving order, no dupes.
        seen = set(entry["classes"])
        for c in classes:
            if c not in seen:
                entry["classes"].append(c)
                seen.add(c)

    result = list(by_name.values())
    result.sort(key=lambda e: priorities.get(e["classifier_name"], 999))
    return result


async def get_tidy_classifiers(survey: str) -> list[dict[str, Any]]:
    raw = await alerce_client.get_classifiers(survey)
    return tidy_classifiers(raw, survey)

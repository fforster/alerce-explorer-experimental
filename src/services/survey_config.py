"""Survey abstraction — LSST and ZTF differ in API hosts, URL paths, field
names, and band sets. All survey-specific logic lives here; never branch on
the survey string in callers — extend this config instead.

Mirrors the SURVEY_CONFIG / SC() pattern from ../ALeRCE_explorer/alerce_explorer.html.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable


@dataclass(frozen=True)
class SurveyConfig:
    name: str
    api_base: str  # trailing slash included
    classifiers_path: str
    objects_path: str
    object_path_template: str  # uses {oid}
    lightcurve_url_template: str  # full URL; uses {oid}
    # Stamp URL template + per-type name mapping. `{identifier}` is the ZTF
    # candid or LSST measurement_id. `{stamp_type}` is the survey-specific
    # type name (see stamp_type_names). Returns gzip-FITS.
    stamp_url_template: str
    # Maps the logical stamp-type ("science", "template", "difference") to the
    # name the survey's stamp API expects.
    stamp_type_names: dict[str, str]
    bands: tuple[str, ...]
    default_classifier: str
    has_forced_phot: bool
    has_science_flux: bool
    extinction_r: dict[str, float] = field(default_factory=dict)
    extra_params: Callable[[dict[str, object]], dict[str, object]] = lambda p: p

    def classifiers_url(self) -> str:
        return self.api_base + self.classifiers_path

    def objects_url(self) -> str:
        return self.api_base + self.objects_path

    def object_url(self, oid: str) -> str:
        return self.api_base + self.object_path_template.format(oid=oid)

    def lightcurve_url(self, oid: str) -> str:
        return self.lightcurve_url_template.format(oid=oid)

    def stamp_url(self, *, oid: str, identifier: str, stamp_type: str) -> str:
        survey_type = self.stamp_type_names[stamp_type]
        return self.stamp_url_template.format(
            oid=oid, identifier=identifier, stamp_type=survey_type
        )


def _ztf_extra_params(params: dict[str, object]) -> dict[str, object]:
    """Strip Nones, rename fields, add ranking=1, sort by probability DESC.

    Matches the prototype's SURVEY_CONFIG.ztf.extraParams behavior.
    """
    out = {k: v for k, v in params.items() if v is not None and k != "survey"}
    if "class_name" in out:
        out["class"] = out.pop("class_name")
    if "n_det" in out:
        out["ndet"] = out.pop("n_det")
    out.setdefault("ranking", 1)
    out.setdefault("order_by", "probability")
    out.setdefault("order_mode", "DESC")
    return out


def _lsst_extra_params(params: dict[str, object]) -> dict[str, object]:
    out = {k: v for k, v in params.items() if v is not None}
    # The LSST list_objects endpoint expects survey as a query param and
    # already returns rows ordered by descending probability; we pass the
    # order hints anyway so behavior is explicit.
    out.setdefault("survey", "lsst")
    out.setdefault("order_by", "probability")
    out.setdefault("order_mode", "DESC")
    return out


SURVEY_CONFIG: dict[str, SurveyConfig] = {
    "lsst": SurveyConfig(
        name="lsst",
        api_base="https://api-lsst.alerce.online/",
        classifiers_path="classifier_api/classifiers",
        objects_path="object_api/list_objects",
        object_path_template="object_api/object?survey_id=lsst&oid={oid}",
        lightcurve_url_template=(
            "https://api-lsst.alerce.online/lightcurve_api/lightcurve"
            "?survey_id=lsst&oid={oid}"
        ),
        stamp_url_template=(
            "https://api-lsst.alerce.online/stamps_api/stamp"
            "?survey_id=lsst&oid={oid}&measurement_id={identifier}"
            "&stamp_type={stamp_type}&file_format=fits&is_compressed=false"
        ),
        stamp_type_names={
            "science": "cutoutScience",
            "template": "cutoutTemplate",
            "difference": "cutoutDifference",
        },
        bands=("u", "g", "r", "i", "z", "y"),
        default_classifier="lc_classifier_top",
        has_forced_phot=False,
        has_science_flux=False,
        extinction_r={
            "u": 4.145, "g": 3.237, "r": 2.273,
            "i": 1.684, "z": 1.323, "y": 1.088,
        },
        extra_params=_lsst_extra_params,
    ),
    "ztf": SurveyConfig(
        name="ztf",
        api_base="https://api.alerce.online/ztf/v1/",
        classifiers_path="classifiers",
        objects_path="objects",
        object_path_template="objects/{oid}",
        lightcurve_url_template="https://api.alerce.online/ztf/v1/objects/{oid}/lightcurve",
        stamp_url_template=(
            "https://avro.alerce.online/get_stamp"
            "?oid={oid}&candid={identifier}&type={stamp_type}&format=fits"
        ),
        stamp_type_names={
            "science": "science",
            "template": "template",
            "difference": "difference",
        },
        bands=("g", "r", "i"),
        default_classifier="lc_classifier",
        has_forced_phot=True,
        has_science_flux=True,
        extinction_r={"g": 3.237, "r": 2.273, "i": 1.684},
        extra_params=_ztf_extra_params,
    ),
}


def SC(survey: str) -> SurveyConfig:
    try:
        return SURVEY_CONFIG[survey]
    except KeyError as e:
        raise ValueError(f"Unknown survey: {survey!r}") from e


def known_surveys() -> tuple[str, ...]:
    return tuple(SURVEY_CONFIG.keys())

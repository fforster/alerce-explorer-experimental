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
    # Forced-photometry URL. For LSST this is a dedicated endpoint that returns
    # a plain list of FP records. For ZTF it's the v2 lightcurve endpoint which
    # returns {detections, non_detections, forced_photometry} — we only read
    # the forced_photometry key. None if the survey doesn't expose FP.
    fp_url_template: str | None  # full URL; uses {oid}
    # Stamp URL template + per-type name mapping. `{identifier}` is the ZTF
    # candid or LSST measurement_id. `{stamp_type}` is the survey-specific
    # type name (see stamp_type_names). Returns gzip-FITS.
    stamp_url_template: str
    # Maps the logical stamp-type ("science", "template", "difference") to the
    # name the survey's stamp API expects.
    stamp_type_names: dict[str, str]
    # Returns a flat list of probability rows (one per class per classifier).
    prob_url_template: str  # full URL; uses {oid}
    bands: tuple[str, ...]
    default_classifier: str
    has_forced_phot: bool
    has_science_flux: bool
    # Features endpoint (ZTF only so far). Used to fetch `Multiband_period` for
    # the phase-folding button in the light curve panel. None means the survey
    # doesn't publish features via the REST API.
    features_url_template: str | None = None
    extinction_r: dict[str, float] = field(default_factory=dict)
    # Per-band effective wavelength (Ångström). Drives the multi-band Gaussian
    # Process overlay: the GP kernel correlates bands by how close their central
    # wavelengths are (an RBF over wavelength), so a band's shape can inform a
    # poorly-sampled neighbour. Shared across surveys by wavelength, so ZTF g
    # (~4746 Å) and LSST g (~4827 Å) come out strongly coupled in a cross-survey
    # joint fit. Approximate effective wavelengths from the survey filter curves.
    band_wavelengths: dict[str, float] = field(default_factory=dict)
    extra_params: Callable[[dict[str, object]], dict[str, object]] = lambda p: p
    # Time scale of MJDs returned by this survey's API. LSST alerts carry
    # `midpointMjdTai` (atomic time, currently UTC + 37 s); ZTF MJDs are UTC.
    # Used by mjd→calendar-date conversion so the UI doesn't show TAI as UTC
    # (see community.lsst.org thread "Question about midpointMjdTai to UTC
    # conversion in recent Rubin alerts" — multiple brokers initially shipped
    # the unconverted TAI string).
    mjd_scale: str = "utc"

    def classifiers_url(self) -> str:
        return self.api_base + self.classifiers_path

    def objects_url(self) -> str:
        return self.api_base + self.objects_path

    def object_url(self, oid: str) -> str:
        return self.api_base + self.object_path_template.format(oid=oid)

    def lightcurve_url(self, oid: str) -> str:
        return self.lightcurve_url_template.format(oid=oid)

    def fp_url(self, oid: str) -> str | None:
        if not self.fp_url_template:
            return None
        return self.fp_url_template.format(oid=oid)

    def stamp_url(self, *, oid: str, identifier: str, stamp_type: str) -> str:
        survey_type = self.stamp_type_names[stamp_type]
        return self.stamp_url_template.format(
            oid=oid, identifier=identifier, stamp_type=survey_type
        )

    def prob_url(self, oid: str) -> str:
        return self.prob_url_template.format(oid=oid)

    def features_url(self, oid: str) -> str | None:
        if not self.features_url_template:
            return None
        return self.features_url_template.format(oid=oid)


# Current TAI − UTC offset in seconds. Constant since 2017-01-01 (most recent
# leap second); next change will be announced by IERS. Bumping this is the
# only edit needed when a new leap second is introduced.
TAI_MINUS_UTC_SECONDS = 37


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
        fp_url_template=(
            "https://api-lsst.alerce.online/lightcurve_api/forced-photometry"
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
        prob_url_template=(
            "https://api-lsst.alerce.online/probability_api/probability"
            "?survey_id=lsst&oid={oid}"
        ),
        bands=("u", "g", "r", "i", "z", "y"),
        default_classifier="stamp_classifier_rubin_beta_20260421",
        has_forced_phot=True,
        has_science_flux=True,
        extinction_r={
            "u": 4.145, "g": 3.237, "r": 2.273,
            "i": 1.684, "z": 1.323, "y": 1.088,
        },
        band_wavelengths={
            "u": 3671.0, "g": 4827.0, "r": 6223.0,
            "i": 7546.0, "z": 8691.0, "y": 9712.0,
        },
        extra_params=_lsst_extra_params,
        mjd_scale="tai",
    ),
    "ztf": SurveyConfig(
        name="ztf",
        api_base="https://api.alerce.online/ztf/v1/",
        classifiers_path="classifiers",
        objects_path="objects",
        object_path_template="objects/{oid}",
        lightcurve_url_template="https://api.alerce.online/ztf/v1/objects/{oid}/lightcurve",
        fp_url_template="https://api.alerce.online/v2/lightcurve/lightcurve/{oid}?survey_id=ztf",
        stamp_url_template=(
            "https://avro.alerce.online/get_stamp"
            "?oid={oid}&candid={identifier}&type={stamp_type}&format=fits"
        ),
        stamp_type_names={
            "science": "science",
            "template": "template",
            "difference": "difference",
        },
        prob_url_template="https://api.alerce.online/ztf/v1/objects/{oid}/probabilities",
        features_url_template="https://api.alerce.online/ztf/v1/objects/{oid}/features",
        bands=("g", "r", "i"),
        default_classifier="lc_classifier_BHRF_forced_phot",
        has_forced_phot=True,
        has_science_flux=True,
        extinction_r={"g": 3.237, "r": 2.273, "i": 1.684},
        band_wavelengths={"g": 4746.0, "r": 6366.0, "i": 7829.0},
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

from src.services.classifiers import tidy_classifiers


def test_tidy_dedupes_by_name_and_merges_classes():
    raw = [
        {"classifier_name": "lc_classifier", "classifier_version": "v1",
         "classes": ["SN", "AGN"]},
        {"classifier_name": "lc_classifier", "classifier_version": "v2",
         "classes": ["AGN", "VS"]},
    ]
    out = tidy_classifiers(raw, "ztf")
    assert len(out) == 1
    assert out[0]["classifier_name"] == "lc_classifier"
    assert out[0]["classes"] == ["SN", "AGN", "VS"]


def test_tidy_sorts_by_priority():
    raw = [
        {"classifier_name": "stamp_classifier", "classes": []},
        {"classifier_name": "lc_classifier", "classes": []},
    ]
    out = tidy_classifiers(raw, "ztf")
    assert [e["classifier_name"] for e in out] == ["lc_classifier", "stamp_classifier"]


def test_tidy_accepts_dict_wrapper():
    raw = {"classifiers": [{"classifier_name": "lc_classifier_top", "classes": ["SN"]}]}
    out = tidy_classifiers(raw, "lsst")
    assert out[0]["classifier_name"] == "lc_classifier_top"


def test_tidy_formats_display_name():
    raw = [{"classifier_name": "lc_classifier_top", "classes": []}]
    out = tidy_classifiers(raw, "lsst")
    assert out[0]["formatted_name"] == "lc classifier top"

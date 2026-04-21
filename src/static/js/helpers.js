// Client-side helpers used by hx-vals='js:{...helper()}' attributes.
// Keep these thin — they exist only to collect DOM state into a query payload
// that htmx serializes onto its outgoing request.

function _val(id) {
  const el = document.getElementById(id);
  if (!el) return "";
  return (el.value ?? "").toString().trim();
}

// Collect current filter-form state.
function send_form_Data() {
  const form = document.getElementById("form-search");
  const survey = form?.dataset?.survey ?? "lsst";

  const classifier = _val("classifier");
  const className = _val("class_name");
  const probability = _val("prob_range");
  const oidsRaw = _val("objectIds");
  const minDet = _val("min_detections");
  const maxDet = _val("max_detections");

  const payload = { survey };
  if (classifier) payload.classifier = classifier;
  if (className) payload.class_name = className;
  if (probability && parseFloat(probability) > 0) payload.probability = probability;
  // `oids` (plural) is the free-text OID-list search. Distinct from the detail
  // view's `oid=` (single-object), which shares the URL namespace but means
  // something different — rename here so a search + detail URL can coexist.
  if (oidsRaw) payload.oids = oidsRaw;
  if (minDet) payload.n_det_min = minDet;
  if (maxDet) payload.n_det_max = maxDet;
  return payload;
}

function send_pagination_data(page) {
  return { page };
}

function send_order_data(order_by, order_mode) {
  return {
    order_by: order_by && order_by !== "None" ? order_by : undefined,
    order_mode: order_mode && order_mode !== "None" ? order_mode : "DESC",
  };
}

// Read the classes[] attached to the currently-selected classifier option.
function send_classes_data() {
  const sel = document.getElementById("classifier");
  if (!sel) return { classifier_classes: [] };
  const opt = sel.options[sel.selectedIndex];
  let classes = [];
  try {
    classes = JSON.parse(opt?.dataset?.classes ?? "[]");
  } catch {
    classes = [];
  }
  return { classifier_classes: classes };
}

window.send_form_Data = send_form_Data;
window.send_pagination_data = send_pagination_data;
window.send_order_data = send_order_data;
window.send_classes_data = send_classes_data;

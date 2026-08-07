import os
path = "/home/user/virtual-sports-predictor/src/dashboard/index.html"
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# Replace API detection logic
old_api_line = "const API = location.origin;"
new_api_logic = """
// Auto-detect API: local FastAPI has /stats, /predict_all
// Netlify has /api/stats -> redirects to /.netlify/functions/stats and /api/predict_all
// Render has same as local
const isNetlify = location.hostname.includes('netlify.app') || location.hostname.includes('netlify');
const API_BASE = isNetlify ? `${location.origin}/api` : location.origin;
const API = API_BASE;

// Helper to build endpoint with fallback
function apiUrl(path) {
  // path like /stats, /predict_all, etc.
  if (isNetlify) {
    // On Netlify, try /api/* first (redirects to functions)
    if (path.startsWith('/')) return `${API_BASE}${path}`;
    return `${API_BASE}/${path}`;
  }
  return `${API_BASE}${path.startsWith('/') ? path : '/' + path}`;
}
"""

content = content.replace(old_api_line, new_api_logic)

# Replace all fetch(`${API}/stats`) etc with apiUrl
content = content.replace("fetch(`${API}/stats`)", "fetch(apiUrl('/stats'))")
content = content.replace("fetch(`${API}/train`", "fetch(apiUrl('/train')")
content = content.replace("fetch(`${API}/train_all`", "fetch(apiUrl('/train_all')")
content = content.replace("fetch(`${API}/predict`", "fetch(apiUrl('/predict')")
content = content.replace("fetch(`${API}/predict_over_under`", "fetch(apiUrl('/predict_over_under')")
content = content.replace("fetch(`${API}/predict_all`", "fetch(apiUrl('/predict_all')")
content = content.replace("fetch(`${API}/predict_matchday`", "fetch(apiUrl('/predict_matchday')")
content = content.replace("fetch(`${API}/collect`", "fetch(apiUrl('/collect')")

# Also fix direct /api calls that might still use API
# Ensure log shows API base
content = content.replace("V2 Loaded. Models:", "V2 Loaded. API_BASE: \" + API_BASE + \" Models:")

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)

print("Fixed src/dashboard/index.html")

# Copy to netlify-deploy/public
import shutil
shutil.copy(path, "/home/user/virtual-sports-predictor/netlify-deploy/public/index.html")
print("Copied to netlify-deploy/public/index.html")

# Also fix netlify.toml to redirect /stats etc
netlify_toml_path = "/home/user/virtual-sports-predictor/netlify.toml"
with open(netlify_toml_path, 'r') as f:
    toml = f.read()

# Add redirects for /stats, /train, etc.
if "/stats" not in toml or 'from = "/stats"' not in toml:
    extra_redirects = """
[[redirects]]
  from = "/stats"
  to = "/.netlify/functions/stats"
  status = 200

[[redirects]]
  from = "/history"
  to = "/.netlify/functions/stats"
  status = 200

[[redirects]]
  from = "/train"
  to = "/.netlify/functions/train"
  status = 200

[[redirects]]
  from = "/train_all"
  to = "/.netlify/functions/train"
  status = 200

[[redirects]]
  from = "/predict"
  to = "/.netlify/functions/predict_all"
  status = 200

[[redirects]]
  from = "/predict_all"
  to = "/.netlify/functions/predict_all"
  status = 200

[[redirects]]
  from = "/predict_over_under"
  to = "/.netlify/functions/predict_all"
  status = 200

[[redirects]]
  from = "/predict_matchday"
  to = "/.netlify/functions/predict_all"
  status = 200

[[redirects]]
  from = "/collect"
  to = "/.netlify/functions/collect"
  status = 200

"""
    toml = toml.replace("[[redirects]]\n  from = \"/*\"", extra_redirects + "[[redirects]]\n  from = \"/*\"")
    with open(netlify_toml_path, 'w') as f:
        f.write(toml)
    print("Added extra redirects to netlify.toml")
else:
    print("Redirects already exist")

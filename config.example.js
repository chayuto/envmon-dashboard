// Copy to config.js and fill in. config.js is what the app actually loads.
//
// The token is a dashboard_reader JWT: it can SELECT the reading_5m view and
// nothing else. It ships in the page and is therefore public by design — that
// is why it is not the publishable key and not service_role. Mint it with
// supabase/mint_dashboard_jwt.py in the firmware repo.
window.ENVMON_CONFIG = {
  supabaseUrl: "https://YOUR_PROJECT_REF.supabase.co",
  token: "PASTE_DASHBOARD_JWT_HERE",

  // Sustained relative humidity above this supports mould growth. The whole
  // dashboard is oriented around this line rather than around pretty curves.
  humidityThreshold: 65,
};

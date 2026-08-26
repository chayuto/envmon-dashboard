// Copy to config.js and fill in. config.js is what the app actually loads.
//
// TWO credentials are needed, and they are not interchangeable:
//
//   apiKey  the project's publishable key. Supabase's gateway authenticates
//           every request against a real API key before PostgREST ever sees
//           it, so a bare JWT in this header is rejected as "Invalid API key".
//           On its own this key is `anon`, which cannot read reading_5m.
//   token   a dashboard_reader JWT. PostgREST reads its `role` claim and SET
//           ROLEs to it, which is what actually grants the read. Mint it with
//           supabase/mint_dashboard_jwt.py in the firmware repo.
//
// Both ship in the page and are public by design. Neither is service_role, and
// the JWT alone cannot write anything.
window.ENVMON_CONFIG = {
  supabaseUrl: "https://YOUR_PROJECT_REF.supabase.co",
  apiKey: "sb_publishable_YOUR_KEY_HERE",
  token: "PASTE_DASHBOARD_JWT_HERE",

  // Sustained relative humidity above this supports mould growth. The whole
  // dashboard is oriented around this line rather than around pretty curves.
  humidityThreshold: 65,
};

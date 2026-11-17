// Example hub settings used by the tests (set before src/hub.js loads). Your own hub sets these in its service unit.
process.env.BOT_HUB_GROUP_WAKE ??= "mentor,chief,lead";
process.env.BOT_HUB_CLASS_WAKE ??= "mentor";
process.env.BOT_HUB_NEVER_GUEST_WAKE ??= "coder,seller";
process.env.BOT_HUB_WATCH_INSTRUCTORS ??= "mentor";
process.env.BOT_HUB_SEED_GROUPS ??= "sales:Alice,Seller;coders:Coder,Dev";
process.env.BOT_HUB_SERVER_LABELS ??= "server1=server1,laptop1=laptop,laptop=laptop";

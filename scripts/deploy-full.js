/**
 * Same as scripts/deploy.js, but also runs the wiring the admin panel would do:
 * sets both tokens, exempts the farm on the mocks, funds it and starts the drip.
 * Use it when you want a farm that is immediately usable; use plain
 * `npm run deploy:local` when you want to rehearse the admin flow by hand.
 */
process.env.AUTO_WIRE = "1";
require("./deploy.js");

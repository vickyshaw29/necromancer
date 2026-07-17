const { writeFileSync } = require("node:fs");

writeFileSync("prepare-ran", "unexpected lifecycle execution\n");

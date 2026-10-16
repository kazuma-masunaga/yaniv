'use strict';
// Entry so that `node --test tests/` resolves the directory (Node 22 treats the argument as a module path).
require('./engine.test.js');
require('./net.test.js');
require('./pwa.test.js');

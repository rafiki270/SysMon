'use strict';
// Font Awesome Free icons, bundled so the board also works offline.
const fs = require('node:fs');
const path = require('node:path');
const brands = require('@fortawesome/free-brands-svg-icons');
const solid = require('@fortawesome/free-solid-svg-icons');
const output = path.join(__dirname, '../app/renderer/icons');
fs.mkdirSync(output, { recursive: true });
for (const definition of [brands.faWindows, brands.faApple, brands.faLinux, brands.faOpenai, brands.faClaude, solid.faK, brands.faXTwitter, solid.faComputer]) {
  const [width, height, , , paths] = definition.icon;
  const body = [].concat(paths).map(d => `<path fill="#8a9a8f" d="${d}"/>`).join('');
  fs.writeFileSync(path.join(output, `${definition.iconName}.svg`), `<!-- Font Awesome Free 7; icons licensed CC BY 4.0; see LICENSE.txt -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${body}</svg>\n`);
}
fs.copyFileSync(path.join(path.dirname(require.resolve('@fortawesome/free-brands-svg-icons/package.json')), 'LICENSE.txt'), path.join(output, 'LICENSE.txt'));


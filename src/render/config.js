const path = require('path');

const OUTPUT_SIZE = {
  width: 1024,
  height: 1024,
};

const SCALE = 2;

const FONT_STACKS = {
  headline: ['Ethnocentric', 'Orbitron Black', 'Nasalization', 'Eurostile Extended', 'Bank Gothic', 'Arial Black'],
  numbers: ['Eurostile Extended Bold', 'Microgramma', 'Bank Gothic', 'Impact'],
  stats: ['Agency FB', 'Rajdhani Bold', 'Exo 2 SemiBold', 'Arial Bold'],
};

const STYLE_TUNING = {
  strokeScale: 0.12,
  shadowBlur: 8,
  shadowOffsetX: 4,
  shadowOffsetY: 4,
  skewX: -0.18,
  gradientTop: '#CFCFCF',
  gradientBottom: '#8F8F8F',
  solidFill: '#BFBFBF',
  letterSpacing: {
    headline: 2,
    numbers: 1,
    stats: 1,
  },
};

const PATHS = {
  fontsDir: path.join(process.cwd(), 'assets', 'fonts'),
  outputDir: path.join(process.cwd(), 'output'),
};

module.exports = {
  OUTPUT_SIZE,
  SCALE,
  FONT_STACKS,
  STYLE_TUNING,
  PATHS,
};

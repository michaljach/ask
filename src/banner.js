// Full blocks (U+2588) and spaces only. Half blocks (U+2580/2584) are unreliable:
// plenty of terminal fonts draw them full-height, which fuses the letters into one
// solid blob. Four rows at two columns per pixel lands each letter near square
// against the usual 1:2 character cell. The blank lines are part of it - every
// place this appears wants breathing room above and below.
export const BANNER = String.raw`
 ██████ ██████ ██  ██
 ██  ██ ██     ████
 ██████     ██ ████
 ██  ██ ██████ ██  ██

`;

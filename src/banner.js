// Full blocks (U+2588) and spaces only. Half blocks (U+2580/2584) are unreliable:
// plenty of terminal fonts draw them full-height, which fuses the letters into one
// solid blob. Four rows at two columns per pixel lands each letter near square
// against the usual 1:2 character cell.
//
// No surrounding newlines: the leading space on the first row is part of the art,
// so trimming this would shift that row one column left. Call sites add the blank
// lines around it.
export const BANNER = String.raw` ██████ ██████ ██  ██
 ██  ██ ██     ████
 ██████     ██ ████
 ██  ██ ██████ ██  ██`;

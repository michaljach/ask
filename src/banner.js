// Full blocks (U+2588) and spaces only. Half blocks (U+2580/2584) are unreliable:
// plenty of terminal fonts draw them full-height, which fuses the letters into one
// solid blob. Two columns per pixel and four rows tall, so the letters come out
// roughly square against the usual 1:2 character cell instead of stretched.
export const BANNER = String.raw` ██████ ██████ ██  ██
 ██  ██ ██     ████
 ██████     ██ ████
 ██  ██ ██████ ██  ██
`;

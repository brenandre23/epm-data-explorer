import { track as vercelTrack } from '@vercel/analytics';

export function track(event, props) {
  vercelTrack(event, props);
}

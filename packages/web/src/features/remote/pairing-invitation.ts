import { remoteInvitationSchema, type RemoteInvitation } from '@puddle/shared';

/** Validate untrusted QR/clipboard input without following the link or exposing its secret. */
export function parsePairingInvitation(raw: string, service: string): RemoteInvitation {
  if (raw.length > 8192) throw new Error('This is not a Puddle pairing invitation.');
  let invitation: RemoteInvitation;
  try {
    invitation = remoteInvitationSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error('This is not a Puddle pairing invitation.');
  }
  if (invitation.service !== service)
    throw new Error('This pairing invitation belongs to a different remote service.');
  if (invitation.expires <= Date.now())
    throw new Error('This pairing invitation has expired. Create a new one on your host.');
  return invitation;
}

export function parsePairingLink(
  text: string,
  appOrigin: string,
  service: string,
): RemoteInvitation {
  if (text.length > 8192) throw new Error('This is not a Puddle pairing link.');
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new Error('This is not a Puddle pairing link.');
  }
  if (url.origin !== appOrigin || url.username || url.password)
    throw new Error('This pairing link belongs to a different Puddle app.');
  const fragment = new URLSearchParams(url.hash.slice(1));
  const raw = fragment.get('pair');
  if (url.pathname !== '/remote/pair' || !raw || fragment.getAll('pair').length !== 1)
    throw new Error('This is not a Puddle pairing link.');
  return parsePairingInvitation(raw, service);
}

// Strip invitations before rendering, fetching or loading any repository content.
export function takePairingInvitation(service: string): RemoteInvitation | null {
  const fragment = new URLSearchParams(location.hash.slice(1)).get('pair');
  if (fragment !== null) history.replaceState(null, '', location.pathname);
  try {
    const raw = fragment ?? sessionStorage.getItem('puddle.pending-pair');
    if (!raw) return null;
    const invitation = parsePairingInvitation(raw, service);
    // Survives the provider redirect in this tab only. Never a durable login credential.
    sessionStorage.setItem('puddle.pending-pair', raw);
    return invitation;
  } catch {
    sessionStorage.removeItem('puddle.pending-pair');
    return null;
  }
}

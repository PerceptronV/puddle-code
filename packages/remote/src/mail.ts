import nodemailer from 'nodemailer';

/** Connection policy belongs to the transport, never message defaults. */
export function createMailer(address: string) {
  const url = new URL(address);
  url.searchParams.set('requireTLS', 'true');
  url.searchParams.set('ignoreTLS', 'false');
  return nodemailer.createTransport(url.toString());
}

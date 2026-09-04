/**
 * Stub for optional dependencies Privy references but this app never uses.
 *
 * Privy's bundle imports Stripe's SDK for its fiat on-ramp. That feature is
 * not enabled here, so the import is aliased to this rather than shipping a
 * payments library that is never called.
 */
export const loadStripe = () => Promise.resolve(null);
export default {};

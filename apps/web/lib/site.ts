/// Where this build thinks it lives, and whether that is the real thing.
///
/// A preview of the site runs on another host before launch, serving the same pages under a
/// different name. Left alone, a crawler finds the copy and indexes it: the same words on a domain
/// nobody should ever land on, competing with the site it is a preview of. So anything that talks
/// to a crawler asks this module first, and only the real host invites one in.
///
/// Deliberately free of `lib/config`: that module builds the wagmi config at import time, and a
/// metadata route has no business pulling a wallet stack into the build.

/// @dev Empty is absent. Docker passes every build arg through whether it was filled in or not, so
///      an unset variable arrives as "" rather than as undefined, and `??` hands that empty string
///      straight to `new URL` in the layout's metadataBase: the build dies at page collection with
///      "Invalid URL" and nothing says which variable. Same rule as `configured()` in lib/config.
export const SITE = process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://hood.fam";

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export const CANONICAL = /(^|\.)hood\.fam$/i.test(hostOf(SITE));

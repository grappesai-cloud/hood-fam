/// hood.fam's mark: the name, set tight, with the suffix in the accent. The chrome and the share
/// card both draw it from here, so a brand never has its name written twice.
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={className}>
      hood<span>.fam</span>
    </span>
  );
}

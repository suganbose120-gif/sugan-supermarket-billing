export function installF2Shortcut(target, startNewBill, isBlocked = () => false) {
  const handleKeyDown = event => {
    if (event.key !== 'F2') return;
    event.preventDefault();
    if (!isBlocked()) startNewBill();
  };

  target.addEventListener('keydown', handleKeyDown);
  return () => target.removeEventListener('keydown', handleKeyDown);
}

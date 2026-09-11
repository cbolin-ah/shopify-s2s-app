import { useEffect } from 'react';
import {
  reactExtension,
  useApplyAttributeChange,
  useAttributes,
} from '@shopify/ui-extensions-react/checkout';

export default reactExtension(
  'purchase.checkout.block.render',
  () => <AudiohookVisitorSync />
);

function generateUUID() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function AudiohookVisitorSync() {
  const applyAttributeChange = useApplyAttributeChange();
  const attributes = useAttributes();

  useEffect(() => {
    // Cart attributes from the theme extension normally carry into checkout as
    // checkout attributes. When present, re-apply them defensively (handles
    // edge cases where attributes aren't auto-copied).
    var existing = attributes && attributes.find(function (a) { return a.key === 'ah_visitor_id'; });
    var sessionAttr = attributes && attributes.find(function (a) { return a.key === 'ah_session_id'; });

    if (existing && existing.value) {
      applyAttributeChange({ type: 'updateAttribute', key: 'ah_visitor_id', value: existing.value });
      if (sessionAttr && sessionAttr.value) {
        applyAttributeChange({ type: 'updateAttribute', key: 'ah_session_id', value: sessionAttr.value });
      }
      return;
    }

    // Missing entirely — checkout was entered without ever running the theme
    // script (wallet buttons, a direct checkout link, etc). Stamp fresh IDs
    // here so the resulting order still carries attribution instead of none
    // at all. This won't match a visitor_id from an earlier storefront visit
    // by the same person, but it beats an unattributed purchase.
    applyAttributeChange({ type: 'updateAttribute', key: 'ah_visitor_id', value: generateUUID() });
    applyAttributeChange({ type: 'updateAttribute', key: 'ah_session_id', value: generateUUID() });
  }, []);

  return null;
}

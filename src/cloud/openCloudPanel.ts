// src/cloud/openCloudPanel.ts
//
// Opens (or focuses) the shared "MTAG Cloud" dashboard panel from anywhere in
// the suite. No-ops with a console warning outside the CEP host.

const CLOUD_EXT_ID = 'com.motiontoolbar.panel.cloud';

export const openCloudPanel = (): void => {
  try {
    if (typeof window.__adobe_cep__ !== 'undefined') {
      window.__adobe_cep__.requestOpenExtension(CLOUD_EXT_ID, '');
      return;
    }
  } catch (e) {
    console.warn('Could not open MTAG Cloud panel', e);
  }
  console.warn('MTAG Cloud panel is only available inside the CEP host.');
};

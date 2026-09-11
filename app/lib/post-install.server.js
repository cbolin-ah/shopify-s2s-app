// ─── Web Pixel ────────────────────────────────────────────────────────────────

const CREATE_PIXEL = `#graphql
  mutation webPixelCreate($webPixel: WebPixelInput!) {
    webPixelCreate(webPixel: $webPixel) {
      webPixel { id settings }
      userErrors { field message code }
    }
  }
`;

const UPDATE_PIXEL = `#graphql
  mutation webPixelUpdate($id: ID!, $webPixel: WebPixelInput!) {
    webPixelUpdate(id: $id, webPixel: $webPixel) {
      webPixel { id settings }
      userErrors { field message code }
    }
  }
`;

const GET_PIXEL = `#graphql
  query { webPixel { id } }
`;

export async function createOrUpdateWebPixel(admin, audiohookId, existingPixelId) {
  const settings = JSON.stringify({});

  // If no stored ID, query Shopify directly for the existing pixel
  let pixelId = existingPixelId;
  if (!pixelId) {
    try {
      const getRes = await admin.graphql(GET_PIXEL);
      const getData = await getRes.json();
      pixelId = getData?.data?.webPixel?.id ?? null;
    } catch (e) {
      // proceed to create
    }
  }

  if (pixelId) {
    try {
      const updateRes = await admin.graphql(UPDATE_PIXEL, {
        variables: { id: pixelId, webPixel: { settings } },
      });
      const updateData = await updateRes.json();
      const errs = updateData?.data?.webPixelUpdate?.userErrors;
      if (!errs?.length) return pixelId;
      const notFound = errs.some(e => e.code === "NOT_FOUND" || /not found/i.test(e.message));
      if (!notFound) throw new Error("webPixelUpdate errors: " + JSON.stringify(errs));
    } catch (e) {
      if (!(e instanceof Error)) throw e;
    }
  }

  try {
    const createRes = await admin.graphql(CREATE_PIXEL, {
      variables: { webPixel: { settings } },
    });
    const createData = await createRes.json();
    const errs = createData?.data?.webPixelCreate?.userErrors;
    if (errs?.length) throw new Error("webPixelCreate errors: " + JSON.stringify(errs));
    return createData?.data?.webPixelCreate?.webPixel?.id ?? null;
  } catch (e) {
    if (e instanceof Response) {
      throw new Error(`Pixel API returned HTTP ${e.status} — app may need reinstallation to grant pixel permissions`);
    }
    throw e;
  }
}

// ─── Theme embed block auto-activation ───────────────────────────────────────
// Uses the REST Assets API (requires write_themes scope) to enable the
// Audiohook Cart Sync embed block in the merchant's live theme automatically.

const GET_MAIN_THEME = `#graphql
  query { themes(first: 1, roles: [MAIN]) { nodes { id name } } }
`;

const GET_THEME_FILE = `#graphql
  query getThemeFile($id: ID!, $filenames: [String!]!) {
    theme(id: $id) {
      files(filenames: $filenames, first: 1) {
        nodes {
          filename
          body {
            ... on OnlineStoreThemeFileBodyText {
              content
            }
          }
        }
      }
    }
  }
`;

const UPSERT_THEME_FILE = `#graphql
  mutation upsertThemeFile($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
    onlineStoreThemeFilesUpsert(themeId: $themeId, files: $files) {
      onlineStoreThemeFiles { filename }
      userErrors { field message }
    }
  }
`;

// Returns { status: 'enabled' | 'already_enabled' | 'legacy_theme' | 'error', reason?, message? }
// `message` is merchant-facing (shown in Settings/Dashboard); `reason` is a stable
// code for logs/debugging. Both are omitted on the non-error statuses.
export async function activateThemeEmbedBlock(admin, session) {
  try {
    const themeRes = await admin.graphql(GET_MAIN_THEME);
    const themeData = await themeRes.json();
    const theme = themeData?.data?.themes?.nodes?.[0];
    console.log('[cart-sync] theme lookup:', JSON.stringify(themeData?.data));
    if (!theme) {
      return {
        status: 'error',
        reason: 'no_main_theme',
        message: "Couldn't find your store's live theme. Try again from the theme editor, or contact support if this persists.",
      };
    }

    const themeId = theme.id;

    const fileRes = await admin.graphql(GET_THEME_FILE, {
      variables: { id: themeId, filenames: ['config/settings_data.json'] },
    });
    const fileData = await fileRes.json();
    const rawContent = fileData?.data?.theme?.files?.nodes?.[0]?.body?.content;
    console.log('[cart-sync] settings_data.json present:', !!rawContent);

    // File missing → legacy theme (no JSON template support)
    if (!rawContent) {
      return {
        status: 'legacy_theme',
        reason: 'no_settings_file',
        message: "Your theme doesn't support app embeds (requires Online Store 2.0). Cart Sync can't run on this theme.",
      };
    }

    // Some themes prepend a /* ... */ comment block — strip it before parsing
    const stripped = rawContent.replace(/^\/\*[\s\S]*?\*\/\s*/m, '').trim();
    let settings;
    try {
      settings = JSON.parse(stripped);
    } catch (parseErr) {
      console.error('[cart-sync] settings_data.json parse failed:', parseErr.message);
      return {
        status: 'error',
        reason: 'invalid_theme_settings',
        message: "Your theme's settings file couldn't be read (unexpected format). Contact support to resolve this.",
      };
    }
    console.log('[cart-sync] has current key:', !!settings?.current);

    // Legacy themes use a flat structure without a `current` key
    if (!settings?.current) {
      return {
        status: 'legacy_theme',
        reason: 'no_current_key',
        message: "Your theme doesn't support app embeds (requires Online Store 2.0). Cart Sync can't run on this theme.",
      };
    }

    if (!settings.current.blocks) settings.current.blocks = {};
    const blocks = settings.current.blocks;

    const BLOCK_TYPE = `shopify://apps/audiohook-event-tracker/blocks/audiohook-cart-sync/1`;
    const APP_CLIENT_ID = process.env.SHOPIFY_API_KEY;

    const existing = Object.entries(blocks).find(([, b]) => b.type === BLOCK_TYPE);
    console.log('[cart-sync] existing block found:', !!existing, '| block type used:', BLOCK_TYPE);
    if (existing) {
      const [key, block] = existing;
      if (!block.disabled) return { status: 'already_enabled' };
      settings.current.blocks[key].disabled = false;
    } else {
      const blockKey = `audiohook-${APP_CLIENT_ID}`;
      settings.current.blocks[blockKey] = { type: BLOCK_TYPE, disabled: false, settings: {} };
    }

    const upsertRes = await admin.graphql(UPSERT_THEME_FILE, {
      variables: {
        themeId,
        files: [{ filename: 'config/settings_data.json', body: JSON.stringify(settings, null, 2) }],
      },
    });
    const upsertData = await upsertRes.json();
    const errs = upsertData?.data?.onlineStoreThemeFilesUpsert?.userErrors;
    console.log('[cart-sync] upsert userErrors:', JSON.stringify(errs));
    if (errs?.length) {
      return {
        status: 'error',
        reason: 'theme_write_failed',
        message: `Shopify rejected the theme update: ${errs[0]?.message || 'unknown error'}.`,
      };
    }

    return { status: 'enabled' };
  } catch (err) {
    const detail = err instanceof Response
      ? `HTTP ${err.status} ${err.statusText || ''}`.trim()
      : err?.message || 'unknown error';
    console.error('[cart-sync] exception:', detail);
    return {
      status: 'error',
      reason: 'exception',
      message: `Unexpected error while checking your theme: ${detail}.`,
    };
  }
}

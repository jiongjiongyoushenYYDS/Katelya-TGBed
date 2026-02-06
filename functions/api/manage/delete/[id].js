export async function onRequest(context) {
  const { env, params } = context;
  let fileId = params.id;

  try {
    fileId = decodeURIComponent(fileId);
  } catch (error) {
    console.warn('Failed to decode fileId, using raw value:', fileId);
  }

  console.log('Deleting file:', fileId);

  try {
    if (!env.img_url) {
      throw new Error('KV binding img_url is not configured.');
    }

    const { record, kvKey } = await getRecordWithKey(env, fileId);
    if (!record || !record.metadata) {
      return jsonResponse(
        {
          success: false,
          error: 'File metadata not found.'
        },
        404
      );
    }

    const metadata = record.metadata;
    const isR2 = fileId.startsWith('r2:') || metadata.storageType === 'r2' || metadata.storage === 'r2';

    if (isR2) {
      const r2Key = metadata.r2Key
        || (kvKey?.startsWith('r2:') ? kvKey.slice(3) : null)
        || (fileId.startsWith('r2:') ? fileId.slice(3) : fileId);

      if (!env.R2_BUCKET) {
        throw new Error('R2 bucket is not configured.');
      }
      if (!r2Key) {
        throw new Error('Failed to resolve R2 key.');
      }

      await env.R2_BUCKET.delete(r2Key);
      await env.img_url.delete(kvKey);
      console.log('Deleted R2 object and KV metadata:', { r2Key, kvKey });

      return jsonResponse({
        success: true,
        message: 'Deleted from R2 and KV.',
        fileId,
        r2Key,
        kvKey
      });
    }

    // Telegram path:
    // 1) try to delete Telegram message (best effort)
    // 2) always delete KV metadata in finally
    let telegramDeleted = false;
    let telegramDeleteAttempted = false;
    let telegramDeleteError = null;

    try {
      if (metadata.telegramMessageId) {
        telegramDeleteAttempted = true;
        console.log('Attempting to delete Telegram message:', metadata.telegramMessageId);
        telegramDeleted = await deleteTelegramMessage(metadata.telegramMessageId, env);

        if (!telegramDeleted) {
          console.error('Telegram message deletion failed:', metadata.telegramMessageId);
        }
      } else {
        console.warn('No telegramMessageId found in metadata:', kvKey);
      }
    } catch (error) {
      telegramDeleteError = error;
      console.error('Telegram deleteMessage threw:', error);
      // Do not throw. KV deletion must still run.
    } finally {
      await env.img_url.delete(kvKey);
      console.log('KV metadata deleted:', kvKey);
    }

    return jsonResponse({
      success: true,
      message: telegramDeleted
        ? 'Deleted from Telegram and KV.'
        : 'KV metadata deleted (Telegram deletion best-effort).',
      fileId,
      kvKey,
      telegramDeleteAttempted,
      telegramDeleted,
      warning: telegramDeleted
        ? ''
        : 'Telegram deletion failed or messageId missing, but KV metadata was forcibly deleted.',
      telegramDeleteError: telegramDeleteError ? telegramDeleteError.message : null
    });
  } catch (error) {
    console.error('Delete error:', error);
    return jsonResponse(
      {
        success: false,
        error: error.message
      },
      500
    );
  }
}

async function getRecordWithKey(env, fileId) {
  const prefixes = ['img:', 'vid:', 'aud:', 'doc:', 'r2:', ''];
  const hasKnownPrefix = prefixes.some((prefix) => prefix && fileId.startsWith(prefix));
  const candidateKeys = hasKnownPrefix ? [fileId] : prefixes.map((prefix) => `${prefix}${fileId}`);

  for (const key of candidateKeys) {
    const record = await env.img_url.getWithMetadata(key);
    if (record && record.metadata) {
      return { record, kvKey: key };
    }
  }

  return { record: null, kvKey: fileId };
}

async function deleteTelegramMessage(messageId, env) {
  if (!messageId || !env.TG_Bot_Token || !env.TG_Chat_ID) {
    return false;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${env.TG_Bot_Token}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TG_Chat_ID,
        message_id: messageId
      })
    });

    let data = { ok: false };
    try {
      data = await response.json();
    } catch (jsonError) {
      console.error('Failed to parse Telegram deleteMessage response:', jsonError);
    }

    return response.ok && data.ok;
  } catch (error) {
    console.error('Telegram delete message error:', error);
    return false;
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

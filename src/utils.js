import { app, allowedUsers } from './index.js';

/**
 * Check if user is a slack admin, or on the manual whitelist
 * @param {string} userId | slack user ID to check
 */
export const userIsAdmin = async (userId) => {
  try {
    console.log(`looking up user ${userId}`);
    const res = (
      await app.client.users.info({
        token: process.env.SLACK_OAUTH_TOKEN,
        user: userId
      })
    ).user.is_admin;

    return res || allowedUsers.includes(userId);
  } catch (err) {
    console.error(err);
    return false;
  }
};

/**
 * Returns the output of a users.info call for this user
 * @param {string} userid | User ID
 */
export const getUser = async (userid) => {
  try {
    return (
      await app.client.users.info({
        token: process.env.SLACK_OAUTH_TOKEN,
        user: userid
      })
    ).user;
  } catch (err) {
    console.error(err);
  }
};

/**
 * Returns true if the bot user is a member of the channel
 * @param {string} channel | Channel ID to check membership of
 */
export const botInChannel = async (channel) => {
  try {
    const res = await app.client.conversations.info({
      token: process.env.SLACK_OAUTH_TOKEN,
      channel: channel
    });
    return await res.channel.is_member;
  } catch (err) {
    console.error(err);
  }
};

/**
 * Joins the bot user to a channel
 * @param {string} channel | Channel ID to join
 */
export const joinChannel = async (channel) => {
  try {
    await app.client.conversations.join({
      token: process.env.SLACK_OAUTH_TOKEN,
      channel: channel
    });
  } catch (err) {
    console.error(err);
  }
};

/**
 * Returns the properties of a slack message
 * @param {string} channel | message channel
 * @param {string} ts | message ts
 */
export const getMessage = async (channel, ts) => {
  try {
    const res = await app.client.conversations.history({
      token: process.env.SLACK_OAUTH_TOKEN,
      channel: channel,
      inclusive: 1,
      latest: ts,
      oldest: ts,
      limit: 1
    });

    return res.messages[0] || new Error('No messages found');
  } catch (err) {
    console.error(err);
  }
};

/**
 * This is sort of unnecessary and confusing, but due to the odd way that thread_ts works I did it anyway.
 * It just detects whether it's a top level message w/ thread, top level message without thread, or an in-thread message
 * @param {string} channel | Slack channel of the message
 * @param {string} ts | Slack ts of the message
 */
const getTopLevel = async (channel, ts) => {
  // Parent message - can be identified by a "reply_count" identifier from conversations.replies, but only if it has threaded messages
  // Threaded message - can be identified by a "parent_user_id" identifier from conversations.replies
  // Message without a thread - can be identified by no thread_ts parameter (both the others have one)
  const res = (
    await app.client.conversations.replies({
      token: process.env.SLACK_OAUTH_TOKEN,
      channel: channel,
      ts: ts
    })
  ).messages[0];

  if (!res.hasOwnProperty('thread_ts')) {
    // This means that the message doesn't have a thread, so we can return its own ts
    return ts;
  }

  if (res.hasOwnProperty('reply_count')) {
    // This means that it's a parent message, so we can send it right to the deleter
    return ts;
  }

  if (res.hasOwnProperty('parent_user_id')) {
    // It's a message in a thread, so we have to return the thread_ts value to get the top thread's ts.
    return res.thread_ts;
  }
};

/**
 * Delete a thread of messages
 * @param {string} channel | ID of channel to delete from
 * @param {string} ts | ts of a message in the thread, including the top level one
 */
export const deleteThread = async (channel, ts) => {
  try {
    /* Log the top level message to the admin channel */
    console.log(`Recieved passed in value of ${ts} in channel ${channel}`);
    const parent_ts = await getTopLevel(channel, ts);
    console.log('Got parent ts of ' + parent_ts);

    for await (let page of app.client.paginate('conversations.replies', {
      channel: channel,
      token: process.env.SLACK_OAUTH_TOKEN,
      ts: parent_ts
    })) {
      // This loops through each page
      let m = await page.messages;
      for (const i of await m) {
        // This loops through each message in a page
        if (i.user === 'USLACKBOT') {
          // Don't delete a message from slackbot - incl. "This message is deleted"
          continue;
        }
        console.log(`Deleting ${i.ts} ("${i.text}")`);
        await app.client.chat.delete({
          token: process.env.SLACK_ADMIN_TOKEN,
          ts: i.ts,
          channel: channel
        });
      }
    }
  } catch (err) {
    console.error(err);
  }
};

/**
 * Logs the original top level message to an admin channel
 * @param {string} channel | Channel ID of original message (not admin channel)
 * @param {string} ts | ts of ripped message
 */
export const logDeletion = async (channel, ts) => {
  try {
    // Extract information from the channel & ts
    const parent_ts = await getTopLevel(channel, ts);
    const parent_message = await getMessage(channel, parent_ts);
    const parent_user = await getUser(parent_message.user);

    console.log(`Logging parent message ${parent_ts} to admin channel`);

    // Build attachment with name & text
    const shared_message_attachment = [
      {
        author_name:
          parent_user.profile.display_name_normalized ||
          parent_user.profile.real_name_normalized, // Add real_name_normalized option for bots
        author_link: `slack://user?team=T0266FRGM&id=${parent_user.id}`,
        author_icon: parent_user.profile.image_512,
        color: 'D0D0D0',
        text: parent_message.text,
        footer: `From a ripped parent in <#${channel}>`
      }
    ];

    // Post message to admin channel
    await app.client.chat.postMessage({
      token: process.env.SLACK_OAUTH_TOKEN,
      channel: process.env.SLACK_ADMIN_CHANNEL,
      attachments: shared_message_attachment
    });
  } catch (err) {
    console.error(err);
  }
};

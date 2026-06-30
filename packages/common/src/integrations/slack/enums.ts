/**
 * Who is allowed to trigger an auto-run on an inbound Slack message.
 */
export enum SlackMessageSource {
  Anyone = 'anyone',
  Humans = 'humans',
  Bots = 'bots',
}

/* Native upstream controllers only. AGPL-3.0. Never import app.ts or workers. */
import {Activity} from '../controllers/Activity.js';
import {Analytics} from '../controllers/Analytics.js';
import {Campaigns} from '../controllers/Campaigns.js';
import {Config} from '../controllers/Config.js';
import {Contacts} from '../controllers/Contacts.js';
import {Domains} from '../controllers/Domains.js';
import {Segments} from '../controllers/Segments.js';
import {Templates} from '../controllers/Templates.js';

export function nativePlunkControllers() {
  // Auth, Users, Projects, Emails, Actions, Workflows and webhooks intentionally
  // absent. Staff identity is provided by the website boundary, not Plunk login.
  return [new Activity(), new Analytics(), new Campaigns(), new Config(),
    new Contacts(), new Domains(), new Segments(), new Templates()];
}

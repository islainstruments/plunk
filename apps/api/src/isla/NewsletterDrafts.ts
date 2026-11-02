/* ISLA non-sending newsletter drafts — AGPL-3.0. */
import {randomUUID} from 'node:crypto';

import type {Pool} from 'pg';
import {z} from 'zod';

// No recipients, sender, queue state or provider options are accepted here.
export const draftContent = z.object({
  subject: z.string().trim().min(1).max(300).regex(/^[^\r\n]+$/),
  html: z.string().min(1).max(200000),
  text: z.string().min(1).max(100000).refine(value => value.trim().length > 0),
}).strict();
export type DraftContent = z.infer<typeof draftContent>;
export interface SavedDraft {
  id: string;
  revision: number;
  content: DraftContent;
}
export class NewsletterDrafts {
  constructor(private readonly pool: Pool) {}

  async create(input: DraftContent, actor: string): Promise<SavedDraft> {
    const content = draftContent.parse(input);
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO isla_newsletter.drafts(id,revision,content,updated_by) VALUES($1,1,$2,$3)`,
      [id, JSON.stringify(content), actor],
    );
    return {id, revision: 1, content};
  }

  async get(id: string): Promise<SavedDraft | null> {
    const result = await this.pool.query<SavedDraft>(
      'SELECT id,revision,content FROM isla_newsletter.drafts WHERE id=$1', [id],
    );
    return result.rows[0] ?? null;
  }

  async list(after = ''): Promise<{id: string; revision: number; subject: string}[]> {
    // Bounded keyset pagination, never load a contact or audience table.
    return (await this.pool.query<{id: string; revision: number; subject: string}>(
      "SELECT id,revision,content->>'subject' AS subject FROM isla_newsletter.drafts WHERE id>$1 ORDER BY id LIMIT 21", [after],
    )).rows;
  }

  async getRevision(id: string, revision: number): Promise<SavedDraft | null> {
    const result = await this.pool.query<SavedDraft>(
      'SELECT draft_id AS id,revision,content FROM isla_newsletter.draft_revisions WHERE draft_id=$1 AND revision=$2',
      [id, revision],
    );
    return result.rows[0] ?? null;
  }

  async update(id: string, revision: number, input: DraftContent, actor: string): Promise<SavedDraft | null> {
    const content = draftContent.parse(input);
    // Compare-and-swap prevents simultaneous editors from losing a saved change.
    const result = await this.pool.query<SavedDraft>(
      `UPDATE isla_newsletter.drafts SET revision=revision+1,content=$3,updated_by=$4,updated_at=now()
       WHERE id=$1 AND revision=$2 RETURNING id,revision,content`,
      [id, revision, JSON.stringify(content), actor],
    );
    return result.rows[0] ?? null;
  }
}

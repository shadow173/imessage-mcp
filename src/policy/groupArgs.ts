// manage_group's argument rules. The tool layer applies them before a store is asked for anything, so mock and live
// refuse the same calls with the same words.
import { ToolError } from '../lib/errors.js';
import type { GroupAction } from '../store/types.js';

/** manage_group's arguments as the tool receives them. */
export interface ManageGroupInput {
  title?: string;
  participants?: string[];
  person?: string;
  image_base64?: string;
  clear_icon?: boolean;
}

/** action=create, checked. The participants still have to resolve to at least 2 different people. */
export interface CreateGroup {
  participants: string[];
  /** Trimmed; undefined leaves the group unnamed. */
  title: string | undefined;
}

/** Any other action, checked. */
export type GroupChange =
  /** title is trimmed; '' removes the name. */
  | { action: 'rename'; title: string }
  | { action: 'add' | 'remove'; person: string }
  /** null clears the photo. */
  | { action: 'set_icon'; imageBase64: string | null }
  | { action: 'leave' };

export function validateCreateGroup(a: ManageGroupInput): CreateGroup {
  if (!a.participants?.length)
    throw new ToolError(
      'need_participants',
      'action=create needs participants: at least 2 other people.',
      `Pass participants as a list of names, person_ids, phone numbers or emails${a.person ? '; person is only for add and remove' : ''}.`,
    );
  return { participants: a.participants, title: a.title?.trim() || undefined };
}

/** Checked once the group is known: groupTitle names it in errors. */
export function validateGroupChange(
  action: Exclude<GroupAction, 'create'>,
  a: ManageGroupInput,
  groupTitle: string,
): GroupChange {
  switch (action) {
    case 'rename':
      if (a.title === undefined)
        throw new ToolError(
          'title_required',
          'action=rename needs title, the new group name.',
          'Pass title:"Lake House". To remove the group name, pass title:"".',
        );
      if (a.title !== '' && !a.title.trim())
        throw new ToolError(
          'title_required',
          `title is only spaces, so "${groupTitle}" was not renamed. Nothing was sent.`,
          'Pass title:"New name"; pass exactly "" only to remove the name.',
        );
      return { action, title: a.title.trim() };
    case 'add':
    case 'remove':
      if (!a.person)
        throw new ToolError(
          'need_person',
          `action=${action} needs person.`,
          'Pass the one member to add or remove in person; participants is only for create.',
        );
      return { action, person: a.person };
    case 'set_icon':
      if (a.clear_icon && a.image_base64)
        throw new ToolError(
          'icon_required',
          'Pass image_base64 or clear_icon, not both.',
          'To set a photo pass image_base64; to remove the photo pass clear_icon:true.',
        );
      if (a.clear_icon) return { action, imageBase64: null };
      if (!a.image_base64)
        throw new ToolError(
          'icon_required',
          'action=set_icon needs image_base64, or clear_icon:true to remove the photo.',
          'Pass the base64 bytes of a real PNG, JPEG or HEIC file in image_base64, or clear_icon:true.',
        );
      return { action, imageBase64: a.image_base64 };
    case 'leave':
      return { action };
  }
}

/**
 * Where each kind of file is kept in storage: the one place that builds the paths. A user's own
 * files sit under `users/<user>/`; everything that belongs to a conference sits under
 * `conferences/<conference>/`, so one folder backs up one conference.
 *
 * ```
 * users/<user>/photo-<id>.<ext>
 * conferences/<conference>/
 *   branding/logo-<id>.<ext>
 *   documents/review-instructions-<id>.pdf
 *   papers/<submission>/
 *     versions/v<n>-[camera-ready-]<tag>-<file name>   every version is kept
 *     plagiarism/report-<id>.pdf
 *     supporting/<tag>-<file name>
 *     registration/receipt-<id>.<ext>                   every receipt is kept
 *   participants/<participant>/receipt-<id>.<ext>
 * ```
 */
export const storagePaths = {
  userFolder: (userId: string) => `users/${userId}/`,
  profilePhoto: (userId: string, id: string, ext: string) =>
    `users/${userId}/photo-${id}.${ext}`,

  conferenceLogo: (conferenceId: string, id: string, ext: string) =>
    `conferences/${conferenceId}/branding/logo-${id}.${ext}`,
  reviewInstructions: (conferenceId: string, id: string) =>
    `conferences/${conferenceId}/documents/review-instructions-${id}.pdf`,

  paperFolder: (conferenceId: string, submissionId: string) =>
    `conferences/${conferenceId}/papers/${submissionId}/`,
  /** `tag` keeps two uploads of the same version (a race) from overwriting each other. */
  paperVersion: (
    conferenceId: string,
    submissionId: string,
    file: { version: number; cameraReady: boolean; tag: string; name: string },
  ) =>
    `${storagePaths.paperFolder(conferenceId, submissionId)}versions/v${file.version}-${file.cameraReady ? 'camera-ready-' : ''}${file.tag}-${file.name}`,
  supportingFile: (
    conferenceId: string,
    submissionId: string,
    file: { tag: string; name: string },
  ) =>
    `${storagePaths.paperFolder(conferenceId, submissionId)}supporting/${file.tag}-${file.name}`,
  plagiarismReport: (conferenceId: string, submissionId: string, id: string) =>
    `${storagePaths.paperFolder(conferenceId, submissionId)}plagiarism/report-${id}.pdf`,
  /** The receipt of a paper's registration fee (every upload is kept). */
  paperReceipt: (
    conferenceId: string,
    submissionId: string,
    id: string,
    ext: string,
  ) =>
    `${storagePaths.paperFolder(conferenceId, submissionId)}registration/receipt-${id}.${ext}`,
  /** The receipt of a participant's registration fee (every upload is kept). */
  participantReceipt: (
    conferenceId: string,
    participantId: string,
    id: string,
    ext: string,
  ) =>
    `conferences/${conferenceId}/participants/${participantId}/receipt-${id}.${ext}`,
};

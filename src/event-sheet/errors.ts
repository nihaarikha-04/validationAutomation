/** Thrown when an uploaded sheet cannot be read at all. Recoverable problems inside a
 *  readable sheet become warnings on the normalised EventSheet instead. */
export class EventSheetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventSheetError';
  }
}

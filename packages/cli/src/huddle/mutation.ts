/** No replay, fallback, fresh target lookup or polling may be added here. */
export async function huddleMutation<T>(observe: string, send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (error) {
    throw new Error(
      `${(error instanceof Error ? error.message : String(error)).slice(0, 2048)}\nThe outcome may be uncertain. ${observe} Do not retry automatically.`,
      { cause: error },
    );
  }
}

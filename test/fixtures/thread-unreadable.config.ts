// A config module that cannot be read, and says why with what no thread can
// be handed: a function in its error's cause.
throw new Error('the config could not be read', { cause: { why: 'busy', retry() {} } });

export {};

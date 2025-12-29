this is interesting #file:src/flightpath/PromptQueue.ts:587-596, why not have the internal tracking ID just be "prompt.id" concatenated with the hash? prompts with no id will just get the hash, and prompts with an id will get a stable unique identifier that includes the id. Also, explain the scenarios this is problem? don't we allow duplicate prompts in a queue with same content, what if the workflow is like:

1. plan feature
2. review plan
3. review plan
4. implement feature
5. review implementation
6. review implementation

do we not allow duplicate prompts in a queue? also what scenarios would actually cause prompt to be reloaded with a different ID but same content or reloaded without an ID but same content as a previously-ID'd prompt? Feels like we are trying to fix a bug that does not exist, how does a user get into these scenarios? I understand preventing an already executed prompt from running again on reload, but we can safely assume flightpath is the only one editing these working files, and if a user is editing them manually or changing the IDs around outside of flightpath control, all bets are off anyway right?

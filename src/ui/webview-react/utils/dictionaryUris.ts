export interface DictionaryUris {
  affUri: string;
  dicUri: string;
}

export function getDictionaryUris(): DictionaryUris {
  return {
    affUri: document.body.getAttribute("data-aff-uri") || "./en_US.aff",
    dicUri: document.body.getAttribute("data-dic-uri") || "./en_US.dic",
  };
}

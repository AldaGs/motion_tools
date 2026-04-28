// src/utils/adobe.ts

// Tell TypeScript that CSInterface exists on the global window object
declare global {
  interface Window {
    CSInterface: any;
    cep: any;
  }
}

// Ensure we are actually running inside AE (prevents crashes if you view this in Chrome)
export const isCEPEnvironment = () => {
  return typeof window.CSInterface !== 'undefined';
};

export const evalScript = async (script: string): Promise<string> => {
  return new Promise((resolve) => {
    if (!isCEPEnvironment()) {
      resolve(`CEP Not Found. Simulated execution of: ${script}`);
      return;
    }

    const cs = new window.CSInterface();
    cs.evalScript(script, (result: string) => {
      resolve(result);
    });
  });
};
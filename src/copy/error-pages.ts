// The branded 404 and 500 pages (E11.5-10). Each is a plain heading, one line
// and two links; neither names the failure, a vendor or any machinery.
export const errorPagesCopy = {
  notFound: {
    meta: {
      title: 'Page not found',
      description: 'This Valstara page does not exist or has moved.',
    },
    heading: 'We could not find that page',
    body: 'The link may be mistyped, or the page may have moved.',
  },
  serverError: {
    meta: {
      title: 'Something went wrong',
      description: 'Valstara could not load this page right now.',
    },
    heading: 'Something went wrong on our side',
    body: 'Please try again in a few minutes.',
  },
  home: 'Go to the home page',
  legit: 'Is Valstara legit?',
} as const;

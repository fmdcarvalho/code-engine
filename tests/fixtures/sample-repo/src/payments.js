export class PaymentWorkflow {
  async settleInvoice(invoice) {
    function recordAudit(entry) {
      return `audit:${entry.id}`;
    }

    const receipt = {
      id: invoice.id,
      status: "settled",
      auditTrail: recordAudit(invoice),
    };
    return receipt;
  }
}

export const paymentHandlers = {
  async capture(request) {
    return {
      kind: "capture",
      id: request.id,
    };
  },

  refund(request) {
    return {
      kind: "refund",
      id: request.id,
    };
  },
};

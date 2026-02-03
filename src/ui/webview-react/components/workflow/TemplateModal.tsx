import React, { useState } from "react";
import { Modal, Button } from "../shared";

interface Template {
  id: string;
  name: string;
  description: string;
  path: string;
}

interface TemplateModalProps {
  isOpen: boolean;
  onClose: () => void;
  templates: Template[];
  onSelectTemplate: (templateId: string) => void;
}

export const TemplateModal: React.FC<TemplateModalProps> = ({
  isOpen,
  onClose,
  templates,
  onSelectTemplate,
}) => {
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);

  const handleCreate = () => {
    if (selectedTemplate) {
      onSelectTemplate(selectedTemplate);
      onClose();
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Create from Template"
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleCreate}
            disabled={!selectedTemplate}
          >
            Create Workflow
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Choose a template to start your workflow
        </p>

        <div className="space-y-2">
          {templates.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400 italic">
              No templates available
            </p>
          ) : (
            templates.map((template) => (
              <div
                key={template.id}
                onClick={() => setSelectedTemplate(template.id)}
                className={`p-4 border rounded-md cursor-pointer transition-colors ${
                  selectedTemplate === template.id
                    ? "border-blue-500 bg-blue-50 dark:bg-blue-900 dark:bg-opacity-20"
                    : "border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600"
                }`}
              >
                <div className="flex items-start gap-3">
                  <input
                    type="radio"
                    checked={selectedTemplate === template.id}
                    onChange={() => setSelectedTemplate(template.id)}
                    className="mt-1"
                  />
                  <div className="flex-1">
                    <h3 className="font-medium text-gray-900 dark:text-gray-100">
                      {template.name}
                    </h3>
                    <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                      {template.description}
                    </p>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </Modal>
  );
};
